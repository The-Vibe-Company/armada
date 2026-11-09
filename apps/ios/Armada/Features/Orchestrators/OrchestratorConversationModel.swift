import Foundation
import Observation

/// One orchestrator's conversation and owner actions. Every mutation is fenced by the revision the
/// person saw and carries an idempotency key; a retry after an unknown outcome resends the exact
/// same request. A stale revision refreshes the state and hands the draft back.
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

    struct ActionRequest: Hashable, Sendable {
        let action: OrchestratorAction
        let expectedRevision: Int
    }

    enum LifecycleStatus: Equatable {
        case sending(OperationKind)
        case unconfirmed(OperationKind)
    }

    private(set) var phase: Phase = .loading
    private(set) var detail: OrchestratorDetail?
    private(set) var pending: [PendingBubble] = []
    private(set) var lifecycle: LifecycleStatus?
    private(set) var notice: (text: String, isError: Bool)?
    var draft = ""
    let feed = ConversationFeed()

    @ObservationIgnored private var mutations: [String: PendingMutation<ActionRequest>] = [:]
    @ObservationIgnored private var lifecycleMutation: PendingMutation<ActionRequest>?
    @ObservationIgnored private let service: any OrchestratorService
    @ObservationIgnored let orchestratorID: String
    @ObservationIgnored private let onSignedOut: @MainActor () -> Void

    init(service: any OrchestratorService, orchestratorID: String, onSignedOut: @escaping @MainActor () -> Void) {
        self.service = service
        self.orchestratorID = orchestratorID
        self.onSignedOut = onSignedOut
    }

    var summary: OrchestratorSummary? { detail?.summary }

    /// Why the composer cannot send now, or nil when it can.
    var composerUnavailableReason: String? {
        guard let summary else { return "Loading…" }
        if summary.continuity == .lost {
            return "The saved conversation was lost. Start a new orchestrator to continue."
        }
        if lifecycle != nil { return "Waiting for Armada to confirm the last action." }
        switch summary.state {
        case .ready: return nil
        case .creating: return "Starting. You can write once it is ready."
        case .stopping: return "Stopping…"
        case .stopped: return "Stopped. Resume to continue this conversation."
        case .resuming: return "Resuming the same conversation…"
        case .blocked: return summary.blockedReason ?? "This orchestrator needs attention. See Details."
        case .other: return "This app does not know this orchestrator's state yet."
        }
    }

    var canStop: Bool { summary?.state.canStop == true && lifecycle == nil }

    var canResume: Bool {
        guard let summary, lifecycle == nil else { return false }
        return summary.state.canResume && summary.continuity != .lost
    }

    // MARK: Reading

    func load() async {
        do throws(ServiceFailure) {
            detail = try await service.detail(id: orchestratorID)
            phase = .loaded
        } catch {
            handleReadFailure(error)
        }
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
            default: break
            }
        }
    }

    /// Called whenever the stream changes: drops local bubbles the conversation now shows and
    /// refreshes detail when an event carries a newer revision.
    func streamChanged() async {
        reconcilePending()
        if let summary, feed.latestRevision > summary.revision {
            await load()
        }
    }

    // MARK: Sending

    func send(_ text: String, intent: ComposerIntent) {
        guard let summary, composerUnavailableReason == nil else { return }
        let action: OrchestratorAction = intent == .steer ? .steer(text) : .message(text)
        let mutation = PendingMutation(request: ActionRequest(action: action, expectedRevision: summary.revision))
        mutations[mutation.idempotencyKey] = mutation
        pending.append(PendingBubble(id: mutation.idempotencyKey, text: text, intent: intent, sentAt: .now, status: .sending))
        draft = ""
        notice = nil
        Task { await perform(mutation) }
    }

    func retry(_ bubble: PendingBubble) {
        guard let mutation = mutations[bubble.id], bubble.status == .unconfirmed else { return }
        setStatus(.sending, for: bubble.id)
        Task { await perform(mutation) }
    }

    /// Hides an unconfirmed bubble and returns its text to the draft. The server may still have
    /// accepted it; the conversation shows it if so.
    func dismiss(_ bubble: PendingBubble) {
        removeBubble(bubble.id, restoreDraft: true)
    }

    private func perform(_ mutation: PendingMutation<ActionRequest>) async {
        do throws(ServiceFailure) {
            _ = try await service.perform(
                mutation.request.action,
                orchestratorID: orchestratorID,
                expectedRevision: mutation.request.expectedRevision,
                idempotencyKey: mutation.idempotencyKey
            )
            setStatus(.accepted, for: mutation.idempotencyKey)
            await load()
        } catch {
            switch error {
            case .signedOut:
                onSignedOut()
            case .uncertain, .offline:
                setStatus(.unconfirmed, for: mutation.idempotencyKey)
            case .staleRevision:
                removeBubble(mutation.idempotencyKey, restoreDraft: true)
                notice = (ServiceFailure.staleRevision.message, false)
                await load()
            case .noAccess:
                phase = .noAccess
            case .unavailable(let reason), .rejected(let reason):
                removeBubble(mutation.idempotencyKey, restoreDraft: true)
                notice = (reason, true)
            }
        }
    }

    // MARK: Lifecycle

    func stop() {
        guard let summary, canStop else { return }
        startLifecycle(ActionRequest(action: .stop, expectedRevision: summary.revision))
    }

    func resume() {
        guard let summary, canResume else { return }
        startLifecycle(ActionRequest(action: .resume, expectedRevision: summary.revision))
    }

    func retryLifecycle() {
        guard let lifecycleMutation, case .unconfirmed(let kind) = lifecycle else { return }
        lifecycle = .sending(kind)
        Task { await performLifecycle(lifecycleMutation) }
    }

    private func startLifecycle(_ request: ActionRequest) {
        let mutation = PendingMutation(request: request)
        lifecycleMutation = mutation
        lifecycle = .sending(request.action.kind)
        notice = nil
        Task { await performLifecycle(mutation) }
    }

    private func performLifecycle(_ mutation: PendingMutation<ActionRequest>) async {
        let kind = mutation.request.action.kind
        do throws(ServiceFailure) {
            _ = try await service.perform(
                mutation.request.action,
                orchestratorID: orchestratorID,
                expectedRevision: mutation.request.expectedRevision,
                idempotencyKey: mutation.idempotencyKey
            )
            finishLifecycle()
            await load()
        } catch {
            switch error {
            case .signedOut:
                onSignedOut()
            case .uncertain, .offline:
                lifecycle = .unconfirmed(kind)
            case .staleRevision:
                finishLifecycle()
                notice = ("This orchestrator changed elsewhere. Review its state, then try again.", false)
                await load()
            case .noAccess:
                finishLifecycle()
                phase = .noAccess
            case .unavailable(let reason), .rejected(let reason):
                finishLifecycle()
                notice = (reason, true)
            }
        }
    }

    private func finishLifecycle() {
        lifecycle = nil
        lifecycleMutation = nil
    }

    // MARK: Helpers

    private func setStatus(_ status: PendingBubble.Status, for id: String) {
        guard let index = pending.firstIndex(where: { $0.id == id }) else { return }
        pending[index].status = status
    }

    private func removeBubble(_ id: String, restoreDraft: Bool) {
        guard let index = pending.firstIndex(where: { $0.id == id }) else { return }
        let bubble = pending.remove(at: index)
        mutations[id] = nil
        if restoreDraft {
            draft = draft.isEmpty ? bubble.text : bubble.text + "\n" + draft
        }
    }

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
            if delivered { mutations[bubble.id] = nil }
            return delivered
        }
    }

    private func handleReadFailure(_ error: ServiceFailure) {
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
