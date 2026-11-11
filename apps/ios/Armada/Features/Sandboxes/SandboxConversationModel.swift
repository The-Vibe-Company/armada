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
/// `sandbox/send` has no idempotency key, so a prompt is sent exactly once. When its outcome is
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
    /// The outcome of the person's last send or stop, kept until their next action.
    private(set) var notice: (text: String, isError: Bool)?
    /// A background read that failed after the conversation was shown; cleared by the next success.
    private(set) var readIssue: String?
    /// Bumped when live follow must start again (after it stopped, or the sandbox was deleted).
    private(set) var followGeneration = 0
    var draft = ""
    let feed: ConversationFeed

    /// The turn each accepted bubble opened, to retire it once the transcript shows that turn.
    @ObservationIgnored private var acceptedPrompts: [String: String] = [:]
    @ObservationIgnored private let service: any SandboxService
    @ObservationIgnored let sandboxID: String
    @ObservationIgnored private let orgID: String
    /// The list row's status, shown until the interior state is read.
    @ObservationIgnored private let listedStatus: SandboxStatus?
    @ObservationIgnored private let onSignedOut: @MainActor () -> Void

    init(
        service: any SandboxService,
        sandboxID: String,
        orgID: String,
        listedStatus: SandboxStatus? = nil,
        memory: ConversationMemory? = nil,
        onSignedOut: @escaping @MainActor () -> Void
    ) {
        self.service = service
        self.sandboxID = sandboxID
        self.orgID = orgID
        self.listedStatus = listedStatus
        self.onSignedOut = onSignedOut
        feed = ConversationFeed(key: "sandbox:\(orgID):\(sandboxID.lowercased())", memory: memory)
    }

    /// Why the composer cannot send now, or nil when it can.
    var composerUnavailableReason: String? {
        guard let state else { return "Loading…" }
        if pending.contains(where: { $0.status == .sending }) { return "Sending…" }
        if pending.contains(where: { $0.status == .unconfirmed }) {
            return "Check whether your last prompt arrived, then dismiss it to write again."
        }
        switch state.admission {
        case .open: return nil
        case .turnRunning: return "The agent is working. You can write when this turn ends, or stop the sandbox."
        case .starting: return "Starting. You can write once it is ready."
        case .stopping: return "Stopping…"
        case .failed: return state.statusReason.map { "This sandbox failed: \($0)" } ?? "This sandbox failed."
        case .deleted: return "This sandbox was deleted. Its conversation is no longer available."
        case .unknownStatus: return "This app does not know this sandbox's state yet."
        }
    }

    var canStop: Bool { state?.canStop == true && !stopping }

    var isWorking: Bool { state?.isWorking == true || feed.conversation.running }

    /// A deleted sandbox has no machine left to read events from. The list row decides until the
    /// interior state is read.
    var isDeleted: Bool { (state?.status ?? listedStatus) == .deleted }

    /// The machine status to show now: the interior state's, else the list row's.
    var shownStatus: SandboxStatus? { state?.status ?? listedStatus }

    // MARK: Reading

    /// Reads the interior state. The conversation is read beside it by `follow`, which the screen
    /// starts at once; a refusal of either replaces the interior.
    func open() async {
        if case .failed = phase { phase = .loading }
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
        await feed.follow(fetch, onSignedOut: onSignedOut)
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
    /// stop settles, rarely otherwise. A refusal (access revoked) replaces the interior.
    func watchState() async {
        while !Task.isCancelled, phase == .loaded || phase == .loading {
            let busy = isWorking || stopping || state?.status == .starting || state?.status == .stopping
            try? await Task.sleep(for: busy ? .seconds(3) : .seconds(15))
            guard !Task.isCancelled else { return }
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
        { [service, sandboxID, orgID] (cursor: String?, backward: Bool) async throws(ServiceFailure) -> ConversationEventPage in
            try await service.sandboxEvents(id: sandboxID, orgID: orgID, cursor: cursor, backward: backward)
        }
    }

    /// Returns false when the read was refused or failed before anything was shown.
    private func loadState() async -> Bool {
        do throws(ServiceFailure) {
            state = try await service.sandboxState(id: sandboxID, orgID: orgID)
            readIssue = nil
            if phase == .loading { phase = .loaded }
            return true
        } catch {
            handleReadFailure(error)
            return phase == .loaded
        }
    }

    // MARK: Acting

    func send(_ text: String) {
        guard composerUnavailableReason == nil, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let bubbleID = UUID().uuidString
        pending.append(PendingBubble(id: bubbleID, text: text, intent: .message, sentAt: .now, status: .sending))
        draft = ""
        notice = nil
        Task {
            do throws(ServiceFailure) {
                let accepted = try await service.sendPrompt(sandboxID: sandboxID, orgID: orgID, text: text)
                acceptedPrompts[bubbleID] = accepted.promptID
                setStatus(.accepted, for: bubbleID)
                reconcilePending()
            } catch {
                switch error {
                case .signedOut:
                    onSignedOut()
                case .noAccess:
                    refuseAccess()
                case .uncertain, .offline:
                    setStatus(.unconfirmed, for: bubbleID)
                case .rejected(let reason), .unavailable(let reason):
                    removeBubble(bubbleID, restoreDraft: true)
                    notice = (reason, true)
                }
            }
            _ = await loadState()
        }
    }

    /// Hides an unconfirmed prompt locally. It still appears in the transcript if Armada received it.
    func dismiss(_ bubble: PendingBubble) {
        guard bubble.status == .unconfirmed else { return }
        removeBubble(bubble.id, restoreDraft: false)
    }

    /// Called after confirmation. Stopping keeps the disk and conversations and is safe to repeat.
    func stop() {
        guard canStop else { return }
        stopping = true
        notice = nil
        Task {
            defer { stopping = false }
            do throws(ServiceFailure) {
                _ = try await service.stopSandbox(id: sandboxID, orgID: orgID)
            } catch {
                switch error {
                case .signedOut: onSignedOut()
                case .noAccess: refuseAccess()
                case .uncertain, .offline:
                    notice = ("Armada did not confirm the stop. Its latest state is shown; you can stop again.", true)
                case .rejected(let reason), .unavailable(let reason):
                    notice = (reason, true)
                }
            }
            _ = await loadState()
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
            guard bubble.status == .accepted, let promptID = acceptedPrompts[bubble.id], shown.contains(promptID) else { return false }
            acceptedPrompts[bubble.id] = nil
            return true
        }
    }

    /// The server refused this conversation: it is no longer shown, nor kept in memory.
    private func refuseAccess() {
        feed.forget()
        phase = .noAccess
    }

    private func handleReadFailure(_ error: ServiceFailure) {
        // Leaving the screen cancels the read; that is not a failure to show.
        if Task.isCancelled { return }
        switch error {
        case .signedOut:
            onSignedOut()
        case .noAccess:
            refuseAccess()
        case .unavailable(let reason):
            phase = .unavailable(reason)
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
