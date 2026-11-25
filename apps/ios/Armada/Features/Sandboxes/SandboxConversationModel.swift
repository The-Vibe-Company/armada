import enum ArmadaKit.SandboxPresentation
import Foundation
import Observation

/// One sandbox's conversation for its owner or a current organization admin: the transcript read
/// by cursor, the latest turn's state, sending a prompt and stopping. The server authorizes every
/// read and action; a refusal replaces the interior with an explanation, never a guess.
///
/// Opening never waits on the history: the screen shows at once with the list row's title and
/// status, the turn's state and the conversation are read in parallel, the composer depends on the
/// state only, and the transcript shows what this session already read, otherwise its first page.
///
/// Native providers do not deduplicate `sandbox/send`, so a prompt is sent exactly once. When its outcome is
/// unknown the bubble says so and offers only Dismiss: the transcript shows the prompt if Armada
/// received it, and the person decides whether to write again.
@MainActor
@Observable
final class SandboxConversationModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case unavailable(String)
        case noAccess
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var state: SandboxState?
    private(set) var pending: [PendingBubble] = []
    private(set) var stopping = false
    private(set) var interrupting = false
    /// The outcome of the person's last send, steer, interrupt or stop, kept until their next action.
    private(set) var notice: (text: String, isError: Bool)?
    /// A background read that failed after the conversation was shown; cleared by the next success.
    private(set) var readIssue: String?
    /// Bumped when live follow must start again (after it stopped, or the sandbox was deleted).
    private(set) var followGeneration = 0
    private var recoveringPrompt = true
    var draft = ""
    let feed: ConversationFeed

    private struct AcceptedSteer { let promptID: String; let delivery: String; let text: String; let priorKeys: Set<String> }

    /// The turn each accepted bubble opened, to retire it once the transcript shows that turn.
    @ObservationIgnored private var acceptedPrompts: [String: String] = [:]
    @ObservationIgnored private var acceptedSteers: [String: AcceptedSteer] = [:]
    @ObservationIgnored private let service: any SandboxService
    @ObservationIgnored let sandboxID: String
    @ObservationIgnored private let orgID: String
    @ObservationIgnored private let memory: ConversationMemory?
    @ObservationIgnored private let cacheKey: String
    /// The list row's status and working state, shown until the interior state or stream is read.
    @ObservationIgnored private let listedStatus: SandboxStatus?
    @ObservationIgnored private let listedWorking: Bool
    @ObservationIgnored private let onSignedOut: @MainActor () -> Void
    @ObservationIgnored private var lastLiveThreadStateAt: ContinuousClock.Instant?
    @ObservationIgnored private var lastFullStateAt: ContinuousClock.Instant?

    init(
        service: any SandboxService,
        sandboxID: String,
        orgID: String,
        listedStatus: SandboxStatus? = nil,
        listedWorking: Bool = false,
        memory: ConversationMemory? = nil,
        onSignedOut: @escaping @MainActor () -> Void
    ) {
        self.service = service
        self.sandboxID = sandboxID
        self.orgID = orgID
        self.listedStatus = listedStatus
        self.listedWorking = listedWorking
        self.memory = memory
        self.onSignedOut = onSignedOut
        let key = "sandbox:\(orgID):\(sandboxID.lowercased())"
        cacheKey = key
        feed = ConversationFeed(key: key, memory: memory)
        if let cachedState: SandboxState = memory?.state(for: key) {
            state = cachedState
            phase = .loaded
            recoveringPrompt = false
        }
    }

    /// Why the composer cannot send now, or nil when it can.
    var composerUnavailableReason: String? {
        if pending.contains(where: { $0.status == .sending }) { return "Sending…" }
        if interrupting { return "Interrupting…" }
        if pending.contains(where: { $0.status == .unconfirmed }) {
            return "Check whether your last prompt arrived, then dismiss it to write again."
        }
        guard let state else {
            return SandboxConversationPolicy.coldOpenUnavailableReason(listedStatus: listedStatus)
        }
        guard !recoveringPrompt else { return "Loading…" }
        if let expiry = state.expiresAt, expiry <= .now {
            return "This sandbox expired. Launch a new sandbox on the same branch to continue."
        }
        switch state.admission {
        case .open: return nil
        case .turnRunning:
            return state.status == .stopped ? "Resuming with a queued prompt. You can write once it starts." : nil
        case .starting: return "Starting. You can write once it is ready."
        case .stopping: return "Stopping…"
        case .failed: return state.failureExplanation ?? "This sandbox failed. Launch a new sandbox to continue."
        case .expired: return "This sandbox expired. Launch a new sandbox on the same branch to continue."
        case .cannotResume: return "This sandbox cannot resume. Launch a new sandbox on the same branch to continue."
        case .deleted: return "This sandbox was deleted. Its conversation is no longer available."
        case .unknownStatus: return "This app does not know this sandbox's state yet."
        }
    }

    var canStop: Bool { state?.canStop == true && !stopping }

    var canInterrupt: Bool {
        state?.isWorking == true && !interrupting && !stopping && (state?.status == .ready || state?.status == .running)
    }

    var isWorking: Bool {
        SandboxConversationPolicy.isWorking(
            state: state, feedHasLoaded: feed.hasLoaded, feedRunning: feed.conversation.running,
            listedStatus: listedStatus, listedWorking: listedWorking,
            hasActivePending: pending.contains { $0.status == .sending || $0.status == .accepted }
        )
    }

    /// A deleted sandbox has no machine left to read events from. The list row decides until the
    /// interior state is read.
    var isDeleted: Bool { (state?.status ?? listedStatus) == .deleted }

    /// The machine status to show now: the interior state's, else the list row's.
    var shownStatus: SandboxStatus? { state?.status ?? listedStatus }

    // MARK: Reading

    /// Reads the interior state. The conversation is read beside it by `follow`, which the screen
    /// starts at once; a refusal of either replaces the interior. Warm reopens already render
    /// cached state and revalidate here in the background.
    func open() async {
        if case .failed = phase { phase = .loading }
        do throws(ServiceFailure) { try await recoverUnconfirmedPromptIfNeeded() }
        catch { handleReadFailure(error); return }
        _ = await loadState()
    }

    /// Pull to refresh: the turn's state and anything new in the conversation.
    func refresh() async {
        guard await loadState() else { return }
        guard !isDeleted else { return }
        do throws(ServiceFailure) {
            try await feed.refresh(fetch)
            readIssue = nil
            reconcilePending()
            // A follow that the server stopped resumes once a read succeeds again.
            if case .stopped = feed.connection { followGeneration += 1 }
        } catch {
            handleReadFailure(error)
        }
    }

    /// Shows what is known of the conversation, catches up, then follows it until the screen
    /// disappears or the server stops it.
    func follow() async {
        guard !isDeleted else { return }
        await feed.follow(fetch, stream: stream, isStarting: { self.shownStatus == .starting },
                          onTransition: { [weak self] status, reason in self?.applyLiveTransition(status: status, statusReason: reason) },
                          onSignedOut: onSignedOut)
        guard !Task.isCancelled, case .stopped(let failure) = feed.connection else { return }
        // The history may be refused because the sandbox was deleted meanwhile: its state says so.
        guard await loadState(), !isDeleted else { return }
        handleReadFailure(failure)
    }

    /// Reads older history when the person scrolls to the top of what is shown.
    func loadOlder() async {
        do throws(ServiceFailure) {
            try await feed.loadOlder(fetch)
        } catch {
            handleReadFailure(error)
        }
    }

    /// Keeps the turn's state current while the screen is shown: often while the agent works or a
    /// stop settles, rarely otherwise. Skips redundant `sandbox/status` polls when `logs/read` is
    /// already reporting fresh `threadStatus`/`settled`.
    func watchState() async {
        while !Task.isCancelled, phase == .loaded || phase == .loading {
            let busy = isWorking || stopping || state?.status == .starting || state?.status == .stopping
            try? await Task.sleep(for: busy ? .seconds(3) : .seconds(15))
            guard !Task.isCancelled else { return }
            if shouldSkipStatusPoll() { continue }
            _ = await loadState()
        }
    }

    /// Called whenever the transcript changes: retires bubbles whose turn it now shows, and reads
    /// the state at once when the transcript shows the working turn ended, so the working
    /// indicator and the composer follow the finish without waiting for the next state read (#847).
    func streamChanged() {
        reconcilePending()
        if let turn = state?.turn, state?.isWorking == true, feed.conversation.items.contains(where: { item in
            guard item.promptID == turn.promptID, case .user(_, let status, _) = item.kind else { return false }
            return !status.isActive
        }) {
            Task { _ = await loadState() }
        }
    }

    private var fetch: ConversationFeed.Fetch {
        { [weak self, service, sandboxID, orgID] (cursor: String?, backward: Bool) async throws(ServiceFailure) -> ConversationEventPage in
            let page = try await service.sandboxEvents(id: sandboxID, orgID: orgID, cursor: cursor, backward: backward)
            if let threadState = page.threadState {
                await MainActor.run { [weak self] in
                    self?.applyLiveThreadState(threadState)
                }
            }
            return page
        }
    }

    private var stream: ConversationFeed.Stream {
        { [service, sandboxID, orgID] lastEventID in service.streamSandboxEvents(id: sandboxID, orgID: orgID, lastEventID: lastEventID) }
    }

    private func shouldSkipStatusPoll(now: ContinuousClock.Instant = ContinuousClock.now) -> Bool {
        SandboxConversationPolicy.shouldSkipStatusPoll(
            state: state, stopping: stopping, feedIsLive: feed.connection == .live, sseConnected: feed.isSSEConnected,
            liveAge: lastLiveThreadStateAt?.duration(to: now), fullAge: lastFullStateAt?.duration(to: now)
        )
    }

    private func applyLiveTransition(status: SandboxStatus?, statusReason: String?) {
        guard !Task.isCancelled, phase == .loaded || phase == .loading, let status else { return }
        lastLiveThreadStateAt = ContinuousClock.now
        guard let current = state else { Task { _ = await self.loadState() }; return }
        let result = SandboxConversationPolicy.applyTransition(
            status: status, statusReason: statusReason, to: current,
            failureExplanation: SandboxPresentation.sandboxFailure(statusReason)
        )
        state = result.state; memory?.storeState(result.state, for: cacheKey)
        if result.needsFullReload { Task { _ = await self.loadState() } }
    }

    private func applyLiveThreadState(_ thread: ConversationThreadState) {
        guard !Task.isCancelled, phase == .loaded || phase == .loading else { return }
        lastLiveThreadStateAt = ContinuousClock.now
        guard let current = state else { return }
        let turnChanged = thread.promptID != nil && current.turn?.promptID != thread.promptID
        var turn: SandboxTurnState?
        if let promptID = thread.promptID, let status = thread.promptStatus {
            if let existing = current.turn, existing.promptID == promptID {
                turn = SandboxTurnState(
                    promptID: promptID, status: status, reason: thread.promptReason,
                    requestedModel: existing.requestedModel, observedModel: existing.observedModel,
                    modelSelectionReason: existing.modelSelectionReason,
                    modelSelectionMessage: existing.modelSelectionMessage,
                    rateLimit: status.isActive ? existing.rateLimit : nil
                )
            } else {
                turn = SandboxTurnState(promptID: promptID, status: status, reason: thread.promptReason)
            }
        }
        if thread.status == .ready || thread.status == .running {
            let working = !thread.settled || turn?.status.isActive == true
            let admission: SandboxState.Admission = (current.expiresAt.map { $0 <= .now } == true) ? .expired : (working ? .turnRunning : .open)
            let updated = SandboxState(
                status: thread.status, statusReason: current.statusReason, turn: turn, admission: admission,
                canStop: true, isWorking: working, expiresAt: current.expiresAt,
                preservationWarning: current.preservationWarning, failureExplanation: current.failureExplanation
            )
            state = updated; memory?.storeState(updated, for: cacheKey)
            if current.status == .starting || turnChanged { Task { _ = await self.loadState() } }
        } else if thread.status != current.status {
            Task { _ = await self.loadState() }
        }
    }

    private func recoverUnconfirmedPromptIfNeeded() async throws(ServiceFailure) {
        if let recovery = service as? any SandboxPromptRecovery, pending.isEmpty,
           let saved = try await recovery.unconfirmedPrompt(sandboxID: sandboxID, orgID: orgID) {
            pending = [PendingBubble(id: saved.id.uuidString, text: saved.text, intent: .message, sentAt: saved.sentAt, status: .unconfirmed)]
        }
        recoveringPrompt = false
    }

    /// Returns false when the read was refused or failed before anything was shown.
    private func loadState() async -> Bool {
        do throws(ServiceFailure) {
            let previousStatus = state?.status
            let loaded = try await service.sandboxState(id: sandboxID, orgID: orgID)
            if recoveringPrompt { try await recoverUnconfirmedPromptIfNeeded() }
            state = loaded; memory?.storeState(loaded, for: cacheKey); lastFullStateAt = ContinuousClock.now
            readIssue = nil
            if phase == .loading { phase = .loaded }
            if previousStatus == .starting, loaded.status != .starting, loaded.status != .deleted,
               !feed.hasLoaded, feed.connection == .connecting { followGeneration += 1 }
            if state?.isWorking == false, feed.conversation.running, !isDeleted {
                Task { try? await self.feed.refresh(self.fetch) }
            }
            return true
        } catch {
            handleReadFailure(error)
            return phase == .loaded
        }
    }

    // MARK: Acting

    func send(_ text: String, intent: ComposerIntent = .message) {
        guard composerUnavailableReason == nil, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let bubbleID = UUID().uuidString
        let priorSteerKeys = intent == .steer ? Set(feed.conversation.items.compactMap { item -> String? in
            if case .steer = item.kind { return item.key }; return nil
        }) : []
        pending.append(PendingBubble(id: bubbleID, text: text, intent: intent, sentAt: .now, status: .sending))
        draft = ""
        notice = nil
        Task {
            do throws(ServiceFailure) {
                if intent == .steer {
                    let accepted = try await service.steerSandbox(sandboxID: sandboxID, orgID: orgID, text: text)
                    acceptedSteers[bubbleID] = AcceptedSteer(promptID: accepted.promptID, delivery: accepted.delivery, text: text, priorKeys: priorSteerKeys)
                } else {
                    let accepted = try await service.sendPrompt(sandboxID: sandboxID, orgID: orgID, text: text)
                    acceptedPrompts[bubbleID] = accepted.promptID
                }
                setStatus(.accepted, for: bubbleID)
                reconcilePending()
            } catch {
                switch error.category {
                case .signedOut:
                    onSignedOut()
                case .noAccess:
                    refuseAccess(message: error.message)
                case .uncertain, .offline:
                    setStatus(.unconfirmed, for: bubbleID)
                    notice = (error.message == ServiceFailure.uncertain.message
                        ? error.message : error.message + " " + ServiceFailure.uncertain.message, true)
                case .rejected, .unavailable:
                    removeBubble(bubbleID, restoreDraft: true)
                    notice = (error.message, true)
                }
            }
            feed.wake()
            _ = await loadState()
        }
    }

    /// Interrupts the running turn while keeping the sandbox up for the next prompt.
    func interrupt() {
        guard canInterrupt else { return }
        interrupting = true
        notice = nil
        Task {
            defer { interrupting = false }
            do throws(ServiceFailure) { _ = try await service.interruptSandbox(id: sandboxID, orgID: orgID) }
            catch { handleControlError(error, uncertainNote: "Check whether the turn stopped before trying again.") }
            feed.wake()
            _ = await loadState()
        }
    }

    /// Hides an unconfirmed prompt locally. It still appears in the transcript if Armada received it.
    func dismiss(_ bubble: PendingBubble) {
        guard bubble.status == .unconfirmed else { return }
        if bubble.intent == .steer { removeBubble(bubble.id, restoreDraft: false); return }
        Task {
            do throws(ServiceFailure) {
                if let recovery = service as? any SandboxPromptRecovery,
                   let saved = try await recovery.unconfirmedPrompt(sandboxID: sandboxID, orgID: orgID) {
                    try await recovery.dismissPrompt(id: saved.id, orgID: orgID)
                }
                removeBubble(bubble.id, restoreDraft: false)
            } catch { notice = (error.message, true) }
        }
    }

    /// Called after confirmation. Surface retention warnings even when the request succeeds.
    func stop() {
        guard canStop else { return }
        stopping = true
        notice = nil
        Task {
            defer { stopping = false }
            do throws(ServiceFailure) {
                let receipt = try await service.stopSandbox(id: sandboxID, orgID: orgID)
                if let warning = receipt.preservationWarning { notice = (warning, true) }
            } catch { handleControlError(error, uncertainNote: "The stop is unconfirmed. Check its latest state before stopping again.") }
            _ = await loadState()
        }
    }

    private func handleControlError(_ error: ServiceFailure, uncertainNote: String) {
        switch error.category {
        case .signedOut: onSignedOut()
        case .noAccess: refuseAccess(message: error.message)
        case .uncertain, .offline: notice = (error.message + " " + uncertainNote, true)
        case .rejected, .unavailable: notice = (error.message, true)
        }
    }

    // MARK: Helpers

    private func setStatus(_ status: PendingBubble.Status, for id: String) {
        guard let index = pending.firstIndex(where: { $0.id == id }) else { return }
        pending[index].status = status
    }

    private func removeBubble(_ id: String, restoreDraft: Bool) {
        guard let index = pending.firstIndex(where: { $0.id == id }) else { return }
        let bubble = pending.remove(at: index)
        acceptedPrompts[id] = nil
        acceptedSteers[id] = nil
        if restoreDraft {
            draft = draft.isEmpty ? bubble.text : bubble.text + "\n" + draft
        }
    }

    private func reconcilePending() {
        let shown = Set(feed.conversation.items.compactMap { item -> String? in
            guard case .user = item.kind else { return nil }
            return item.promptID
        })
        pending.removeAll { bubble in
            guard bubble.status == .accepted else { return false }
            if let promptID = acceptedPrompts[bubble.id], shown.contains(promptID) {
                acceptedPrompts[bubble.id] = nil
                return true
            }
            if let steer = acceptedSteers[bubble.id] {
                let restarted = steer.delivery == "restart" && shown.contains(steer.promptID)
                let echoed = feed.conversation.items.contains { item in
                    guard !steer.priorKeys.contains(item.key), case .steer(let steerText, _) = item.kind, steerText == steer.text else { return false }
                    return item.promptID == nil || item.promptID == steer.promptID
                }
                if restarted || echoed {
                    acceptedSteers[bubble.id] = nil
                    return true
                }
            }
            return false
        }
    }

    /// The server refused this conversation: it is no longer shown, nor kept in memory.
    private func refuseAccess(message: String) {
        notice = (message, true)
        state = nil
        feed.forget()
        phase = .noAccess
    }

    private func handleReadFailure(_ error: ServiceFailure) {
        // Leaving the screen cancels the read; that is not a failure to show.
        if Task.isCancelled { return }
        switch error.category {
        case .signedOut:
            onSignedOut()
        case .noAccess:
            refuseAccess(message: error.message)
        case .unavailable:
            phase = .unavailable(error.message)
        default:
            // Once something is shown, a failed read is a banner, never a blank screen.
            if phase == .loaded || feed.hasLoaded {
                readIssue = error.message
            } else {
                phase = .failed(error.message)
            }
        }
    }
}
