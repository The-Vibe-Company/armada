import ArmadaKit
import Foundation
import Observation

/// One orchestrator's conversation and owner actions. Every mutation is fenced by the revision the
/// person saw and saved once as a durable ArmadaKit command; a retry after an unknown outcome
/// resends exactly that command. A stale revision refreshes the state and hands the draft back.
@MainActor
@Observable
final class OrchestratorConversationModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case unavailable(String)
        case noAccess
        case failed(String)
    }

    enum LifecycleStatus: Equatable {
        case sending(OperationKind)
        /// Accepted by the server and still open there; nothing to retry.
        case inProgress(OperationKind)
        case unconfirmed(OperationKind)
    }

    private(set) var phase: Phase = .loading
    private(set) var detail: OrchestratorDetail?
    private(set) var pending: [PendingBubble] = []
    private(set) var lifecycle: LifecycleStatus?
    private(set) var isDiscardingCommand = false
    private(set) var notice: (text: String, isError: Bool)?
    var draft = ""
    let feed = ConversationFeed()

    /// Saved command handle per local bubble id.
    @ObservationIgnored private var handles: [String: String] = [:]
    @ObservationIgnored private var lifecycleHandle: String?
    @ObservationIgnored private var consecutiveReadFailures = 0
    /// Commands the server definitively refused in this launch. ArmadaKit may still keep one saved;
    /// it is never offered again as a retry that cannot succeed.
    @ObservationIgnored private var refusedHandles = Set<String>()
    @ObservationIgnored private let service: any OrchestratorService
    @ObservationIgnored let orchestratorID: String
    @ObservationIgnored private let onSignedOut: @MainActor () -> Void

    init(service: any OrchestratorService, orchestratorID: String, onSignedOut: @escaping @MainActor () -> Void) {
        self.service = service
        self.orchestratorID = orchestratorID
        self.onSignedOut = onSignedOut
    }

    var summary: OrchestratorSummary? { detail?.summary }

    /// What the server's state allows now (ArmadaKit `OrchestratorControls`, the dashboard's rule).
    var controls: ArmadaKit.OrchestratorControls? {
        detail?.controls(agentWorking: feed.conversation.running)
    }

    /// Why the composer cannot send now, or nil when it can. Creation is asynchronous: nothing is
    /// sent before the create operation has succeeded.
    var composerUnavailableReason: String? {
        guard let controls else { return "Loading…" }
        if isDiscardingCommand { return "Forgetting local request tracking…" }
        if lifecycle != nil { return "Waiting for Armada to confirm the last action." }
        return controls.composerNote
    }

    private var lifecycleIdle: Bool { lifecycle == nil && !isDiscardingCommand }
    var canStop: Bool { controls?.canStop == true && lifecycleIdle }
    var canResume: Bool { controls?.canResume == true && lifecycleIdle }
    var canRecover: Bool { controls?.canRecover == true && lifecycleIdle }

    /// Changes whenever the detail polling policy could choose another delay.
    var pollKey: String {
        "\(summary?.state.rawValue ?? "-")|\(detail?.openOperations.map(\.id).joined(separator: ",") ?? "")|\(String(describing: lifecycle))"
    }

    // MARK: Reading

    func load() async {
        do throws(ServiceFailure) {
            detail = try await service.detail(id: orchestratorID)
            phase = .loaded
            consecutiveReadFailures = 0
        } catch {
            consecutiveReadFailures += 1
            handleReadFailure(error)
        }
        await settleFinishedCommand()
        await recoverOpenCommand()
    }

    /// An accepted command stays saved until its final receipt is read. Once detail no longer
    /// lists its operation as open, read that receipt (same command, same key) so it is forgotten.
    private func settleFinishedCommand() async {
        guard let detail else { return }
        let trackedHandle = lifecycleHandle
        guard let open = await service.unresolved(orgID: detail.summary.orgID, orchestratorID: orchestratorID) else {
            // Reading unresolved commands can reconcile a terminal receipt and remove its handle.
            // A send in flight still owns its local state until its submit returns.
            if let trackedHandle, lifecycleHandle == trackedHandle {
                if case .sending = lifecycle { return }
                finishLifecycle()
            }
            return
        }
        if lifecycleHandle == open.handle {
            if case .sending = lifecycle { return }
            lifecycle = open.receipt == nil || open.receipt?.state == .uncertain
                ? .unconfirmed(open.kind) : .inProgress(open.kind)
        }
        guard let receipt = open.receipt, receipt.state != .uncertain,
              !detail.openOperations.contains(where: { $0.id == receipt.id }) else { return }
        await service.settle(handle: open.handle)
        if lifecycleHandle == open.handle, case .inProgress = lifecycle,
           await service.unresolved(orgID: detail.summary.orgID, orchestratorID: orchestratorID)?.handle != open.handle {
            finishLifecycle()
        }
    }

    /// A command saved by an earlier launch (or outliving its bubble) blocks new ones until it
    /// resolves. Show it truthfully: in progress, refused, or unknown with a retry of exactly it.
    private func recoverOpenCommand() async {
        guard lifecycle == nil, lifecycleHandle == nil, let orgID = summary?.orgID,
              !pending.contains(where: { $0.status != .accepted }),
              let open = await service.unresolved(orgID: orgID, orchestratorID: orchestratorID),
              !handles.values.contains(open.handle) else { return }
        if refusedHandles.contains(open.handle) {
            await service.discard(handle: open.handle)
            guard await service.unresolved(orgID: orgID, orchestratorID: orchestratorID)?.handle == open.handle else { return }
            notice = (
                "Armada refused the last request, and it is still saved on this device, so another can't be sent yet. Refresh to retry local cleanup.",
                true
            )
            return
        }
        lifecycleHandle = open.handle
        lifecycle = open.receipt == nil || open.receipt?.state == .uncertain ? .unconfirmed(open.kind) : .inProgress(open.kind)
    }

    /// Follows the event stream until the screen disappears.
    func follow() async {
        let fetch: ConversationFeed.Fetch = { [service, orchestratorID] (cursor: String?) async throws(ServiceFailure) -> OrchestratorEventPage in
            try await service.events(id: orchestratorID, cursor: cursor)
        }
        await feed.follow(fetch, onSignedOut: onSignedOut)
        if case .stopped(let failure) = feed.connection {
            switch failure {
            case .noAccess: phase = .noAccess
            case .unavailable(let reason): phase = .unavailable(reason)
            case .rejected(let reason): notice = ("The conversation stopped updating: \(reason)", true)
            case .signedOut, .staleRevision, .uncertain, .offline: break
            }
        }
    }

    /// Re-reads detail while something is changing on its own: creating, stopping or resuming, or an
    /// operation still open here or on the server (so a create settles and a command's receipt is
    /// read even without a new conversation item). The delay is ArmadaKit's `OrchestratorPolling`;
    /// failed reads back off. Ends when nothing is changing or the screen goes away.
    func pollDetail() async {
        while !Task.isCancelled {
            // No access or no capability is final for this screen: nothing to follow.
            if phase == .noAccess { return }
            if case .unavailable = phase { return }
            let open = !(detail?.openOperations.isEmpty ?? true) || lifecycle != nil
            guard let delay = ArmadaKit.OrchestratorPolling.detailDelay(
                state: summary?.state.rawValue ?? "creating",
                hasOpenOperation: open,
                consecutiveFailures: consecutiveReadFailures
            ) else { return }
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await load()
        }
    }

    /// Called whenever the stream changes: drops local bubbles the conversation now shows and
    /// refreshes detail when an event carries a newer revision.
    func streamChanged() async {
        let before = pending.count
        reconcilePending()
        if let summary, feed.latestRevision > summary.revision || pending.count < before {
            await load()
        }
    }

    // MARK: Sending

    func send(_ text: String, intent: ComposerIntent) {
        guard let summary, composerUnavailableReason == nil else { return }
        let action: OrchestratorAction = intent == .steer ? .steer(text) : .message(text)
        let bubbleID = UUID().uuidString
        let revision = summary.revision
        pending.append(PendingBubble(id: bubbleID, text: text, intent: intent, sentAt: .now, status: .sending))
        draft = ""
        notice = nil
        Task {
            do throws(ServiceFailure) {
                handles[bubbleID] = try await service.prepareMutation(action, orchestratorID: orchestratorID, expectedRevision: revision)
            } catch {
                if error == .signedOut { onSignedOut() }
                removeBubble(bubbleID, restoreDraft: true)
                notice = (error.message, true)
                await recoverOpenCommand()
                return
            }
            await submit(bubbleID)
        }
    }

    func retry(_ bubble: PendingBubble) {
        guard !isDiscardingCommand, handles[bubble.id] != nil, bubble.status == .unconfirmed else { return }
        setStatus(.sending, for: bubble.id)
        Task { await submit(bubble.id) }
    }

    var hasUnconfirmedCommand: Bool {
        if case .unconfirmed = lifecycle { return true }
        return pending.contains { $0.status == .unconfirmed }
    }

    /// Called only after an explicit warning: this forgets tracking, not the server action.
    /// Never restores message text to the draft or automatically resends it as a new intent.
    func discardUnconfirmed(bubbleID: String? = nil) async {
        guard !isDiscardingCommand else { return }
        let bubble = bubbleID.flatMap { id in pending.first { $0.id == id && $0.status == .unconfirmed } }
            ?? (bubbleID == nil ? pending.first { $0.status == .unconfirmed } : nil)
        let handle: String
        if let bubble, let saved = handles[bubble.id] {
            handle = saved
        } else if bubbleID == nil, case .unconfirmed = lifecycle, let saved = lifecycleHandle {
            handle = saved
        } else {
            return
        }
        isDiscardingCommand = true
        defer { isDiscardingCommand = false }
        do throws(ServiceFailure) {
            try await service.discardUncertain(handle: handle)
            if let bubble { removeBubble(bubble.id, restoreDraft: false) }
            if lifecycleHandle == handle { finishLifecycle() }
            notice = ("Local request tracking was forgotten. The action may still have happened; check the latest state before sending a new request.", false)
            await load()
        } catch {
            if error == .signedOut { onSignedOut() }
            notice = (error.message, true)
        }
    }

    private func submit(_ bubbleID: String) async {
        guard let handle = handles[bubbleID] else { return }
        do throws(ServiceFailure) {
            let receipt = try await service.submit(handle: handle)
            if receipt.state == .failed {
                removeBubble(bubbleID, restoreDraft: true)
                notice = (Self.failedMessage(receipt), true)
            } else {
                setStatus(.accepted, for: bubbleID)
            }
            await load()
        } catch {
            switch error {
            case .signedOut:
                onSignedOut()
            case .uncertain, .offline:
                setStatus(.unconfirmed, for: bubbleID)
            case .staleRevision:
                refusedHandles.insert(handle)
                removeBubble(bubbleID, restoreDraft: true)
                notice = (ServiceFailure.staleRevision.message, false)
                await load()
            case .noAccess:
                refusedHandles.insert(handle)
                phase = .noAccess
            case .rejected(let reason):
                refusedHandles.insert(handle)
                removeBubble(bubbleID, restoreDraft: true)
                notice = (reason, true)
            case .unavailable(let reason):
                // Nothing was sent, but the command stays saved: keep it as itself, never as a
                // new draft that could be sent twice.
                setStatus(.unconfirmed, for: bubbleID)
                notice = (reason, true)
            }
        }
    }

    // MARK: Lifecycle

    func stop() {
        guard let summary, canStop else { return }
        startLifecycle(.stop, revision: summary.revision)
    }

    func resume() {
        guard let summary, canResume else { return }
        startLifecycle(.resume, revision: summary.revision)
    }

    /// Settles a blocked orchestrator or an unknown first create without allocating anything new.
    func recover() {
        guard let summary, canRecover else { return }
        startLifecycle(.recover, revision: summary.revision)
    }

    func retryLifecycle() {
        guard !isDiscardingCommand, let lifecycleHandle, case .unconfirmed(let kind) = lifecycle else { return }
        lifecycle = .sending(kind)
        Task { await submitLifecycle(lifecycleHandle, kind: kind) }
    }

    private func startLifecycle(_ action: OrchestratorAction, revision: Int) {
        let kind = action.kind
        lifecycle = .sending(kind)
        notice = nil
        Task {
            do throws(ServiceFailure) {
                let handle = try await service.prepareMutation(action, orchestratorID: orchestratorID, expectedRevision: revision)
                lifecycleHandle = handle
                await submitLifecycle(handle, kind: kind)
            } catch {
                if error == .signedOut { onSignedOut() }
                finishLifecycle()
                notice = (error.message, true)
                await recoverOpenCommand()
            }
        }
    }

    private func submitLifecycle(_ handle: String, kind: OperationKind) async {
        do throws(ServiceFailure) {
            let receipt = try await service.submit(handle: handle)
            finishLifecycle()
            if receipt.state == .failed { notice = (Self.failedMessage(receipt), true) }
            await load()
        } catch {
            switch error {
            case .signedOut:
                onSignedOut()
            case .uncertain, .offline:
                lifecycle = .unconfirmed(kind)
            case .staleRevision:
                refusedHandles.insert(handle)
                finishLifecycle()
                notice = ("This orchestrator changed elsewhere. Review its state, then try again.", false)
                await load()
            case .noAccess:
                refusedHandles.insert(handle)
                finishLifecycle()
                phase = .noAccess
            case .rejected(let reason):
                refusedHandles.insert(handle)
                finishLifecycle()
                notice = (reason, true)
            case .unavailable(let reason):
                lifecycle = .unconfirmed(kind)
                notice = (reason, true)
            }
        }
    }

    private func finishLifecycle() {
        lifecycle = nil
        lifecycleHandle = nil
    }

    // MARK: Helpers

    private func setStatus(_ status: PendingBubble.Status, for id: String) {
        guard let index = pending.firstIndex(where: { $0.id == id }) else { return }
        pending[index].status = status
    }

    private func removeBubble(_ id: String, restoreDraft: Bool) {
        guard let index = pending.firstIndex(where: { $0.id == id }) else { return }
        let bubble = pending.remove(at: index)
        handles[id] = nil
        if restoreDraft {
            draft = draft.isEmpty ? bubble.text : bubble.text + "\n" + draft
        }
    }

    /// Retires an accepted bubble once the conversation shows its own prompt or steer text.
    private func reconcilePending() {
        let shown = feed.conversation.items
        pending.removeAll { bubble in
            guard bubble.status == .accepted else { return false }
            let delivered = shown.contains { item in
                guard item.at >= bubble.sentAt.addingTimeInterval(-60) else { return false }
                switch item.kind {
                case .user(let text, _, _): return bubble.intent == .message && text == bubble.text
                case .steer(let text, _): return bubble.intent == .steer && text == bubble.text
                default: return false
                }
            }
            if delivered { handles[bubble.id] = nil }
            return delivered
        }
    }

    private static func failedMessage(_ receipt: OperationSummary) -> String {
        let reason = receipt.errorCode.map { " " + ArmadaKit.OrchestratorExplanation.text(for: $0) } ?? ""
        return "\(receipt.kind.label) failed.\(reason)"
    }

    private func handleReadFailure(_ error: ServiceFailure) {
        // Leaving the screen cancels the read; that is not a failure to show.
        if Task.isCancelled { return }
        switch error {
        case .signedOut:
            onSignedOut()
        case .unavailable(let reason):
            phase = .unavailable(reason)
        case .noAccess:
            phase = .noAccess
        default:
            if detail == nil {
                phase = .failed(error.message)
            } else {
                notice = (error.message, true)
            }
        }
    }
}
