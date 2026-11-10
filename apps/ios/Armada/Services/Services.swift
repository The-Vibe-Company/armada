import Foundation

/// The presentation's only route to orchestrators and sandboxes. Views never hold a token,
/// build a request or decide authorization: they call these services, which `ArmadaKitServices`
/// implements over the actual `ArmadaKit` client (#690). Mutations follow ArmadaKit's durable
/// command model: prepare once, then submit (and retry) only that handle. In-memory preview data
/// exists only inside `#Preview` blocks and is never selected at runtime.
protocol OrchestratorService: Sendable {
    func list(orgID: String, cursor: String?) async throws(ServiceFailure) -> OrchestratorPage
    func detail(id: String) async throws(ServiceFailure) -> OrchestratorDetail
    /// One page of events after `cursor`; `backward` reads the latest page, or the one before an
    /// older cursor (#812).
    func events(id: String, cursor: String?, backward: Bool) async throws(ServiceFailure) -> OrchestratorEventPage
    func createOptions(orgID: String) async throws(ServiceFailure) -> CreateOptions
    /// Records a create command durably before anything is sent and returns its handle
    /// (ArmadaKit `prepareOrchestratorCreate`): its bytes and idempotency key are fixed here.
    func prepareCreate(_ request: OrchestratorCreateRequest) async throws(ServiceFailure) -> String
    /// Records a message, steer, stop or resume fenced by `expectedRevision`; returns its handle.
    func prepareMutation(
        _ action: OrchestratorAction,
        orchestratorID: String,
        expectedRevision: Int
    ) async throws(ServiceFailure) -> String
    /// Sends, or resends, exactly the prepared command. Never mints a new key.
    func submit(handle: String) async throws(ServiceFailure) -> OperationSummary
    /// A command saved on this device whose outcome is still open, including one from an earlier
    /// launch. `orchestratorID` nil means a create in the organization.
    func unresolved(orgID: String, orchestratorID: String?) async -> UnresolvedOperation?
    /// Forgets a command only when its outcome is final; otherwise does nothing.
    func discard(handle: String) async
    /// Explicitly forgets local tracking of an unknown outcome after the person accepts the risk.
    /// Does not cancel a request or imply that the server did not apply it.
    func discardUncertain(handle: String) async throws(ServiceFailure)
    /// Reads owner detail to reconcile an exact known receipt without sending a mutation.
    /// An unknown outcome without a receipt is retried only by the person.
    func settle(handle: String) async
    /// Follows an accepted create (ArmadaKit `followOrchestratorCreate`): reads the new
    /// orchestrator's detail on ArmadaKit's polling schedule until its create settles. Sends nothing.
    func followCreate(handle: String) async throws(ServiceFailure) -> CreateSettlement
}

/// How an accepted create ended.
enum CreateSettlement: Equatable, Sendable {
    case ready
    /// A plain sentence: the create failed or the orchestrator needs attention.
    case failed(String)
}

extension OrchestratorService {
    /// Services that cannot follow a create report it as unavailable; the list's own refresh still settles it.
    func followCreate(handle: String) async throws(ServiceFailure) -> CreateSettlement {
        throw .unavailable("Following a create isn't available in this build.")
    }

    func discardUncertain(handle: String) async throws(ServiceFailure) {
        throw .unavailable("Forgetting an unconfirmed request isn't available in this build.")
    }
}

protocol SandboxService: Sendable {
    /// `POST /api/v1/sandbox/list`: allowlisted metadata for every current member.
    func list(orgID: String, page: Int) async throws(ServiceFailure) -> SandboxPage
    /// `POST /api/v1/sandbox/detail`: interior state for the owner or a current admin. The server
    /// reauthorizes every call and may refuse (`.noAccess`).
    func sandboxState(id: String, orgID: String) async throws(ServiceFailure) -> SandboxState
    /// `POST /api/v1/logs/read`: one page of the conversation after an opaque cursor; `backward`
    /// reads the latest page, or the one before an older cursor (#812).
    func sandboxEvents(id: String, orgID: String, cursor: String?, backward: Bool) async throws(ServiceFailure) -> OrchestratorEventPage
    /// `POST /api/v1/sandbox/send`: sent exactly once. `.uncertain` means it may have been
    /// delivered; it is never resent automatically because the route has no idempotency key.
    func sendPrompt(sandboxID: String, orgID: String, text: String) async throws(ServiceFailure) -> SandboxPromptAcceptance
    /// `POST /api/v1/sandbox/stop`: the disk and conversations are kept. Safe to repeat.
    func stopSandbox(id: String, orgID: String) async throws(ServiceFailure) -> SandboxStatus
}

/// A saved command whose outcome is still open.
struct UnresolvedOperation: Hashable, Sendable {
    let handle: String
    let kind: OperationKind
    /// The server's receipt when it accepted the command: in progress rather than unknown.
    let receipt: OperationSummary?
}

/// Concise, safe failure categories. No raw response body or transport error reaches a view.
enum ServiceFailure: Error, Hashable, Sendable {
    /// The server or this client does not offer the capability. Shown as such; not retried in a loop.
    /// Never used for a command that may have been sent (that is `.uncertain`).
    case unavailable(String)
    /// The session ended. The app returns to sign-in.
    case signedOut
    /// Missing or concealed (403/404). Never pre-authorized client-side.
    case noAccess
    /// Another change won the revision fence; refresh and keep the draft.
    case staleRevision
    /// A command was sent but its outcome is unknown. Retry the SAME handle.
    case uncertain
    /// A read could not reach Armada. Safe to retry.
    case offline
    /// The server or the client refused the request with a safe, presentable reason.
    case rejected(String)

    var message: String {
        switch self {
        case .unavailable(let reason): reason
        case .signedOut: "Your session ended. Sign in again."
        case .noAccess: "You don't have access to this, or it no longer exists."
        case .staleRevision: "This orchestrator changed elsewhere. The latest state is shown; your draft is kept."
        case .uncertain: "Armada did not confirm this request. Retrying sends the same request again."
        case .offline: "Armada can't be reached. Check your connection."
        case .rejected(let reason): reason
        }
    }
}

/// Services for a build with no usable client (for example, a missing `ARMADA_API_URL`). Every
/// call reports the explicit unavailable capability; nothing is simulated.
struct UnavailableServices: OrchestratorService, SandboxService {
    let reason: String

    static let orchestrators = UnavailableServices(reason: "Orchestrators aren't available in this build.")
    static let sandboxes = UnavailableServices(reason: "Sandboxes aren't available in this build.")

    func list(orgID: String, cursor: String?) async throws(ServiceFailure) -> OrchestratorPage {
        throw .unavailable(reason)
    }

    func detail(id: String) async throws(ServiceFailure) -> OrchestratorDetail {
        throw .unavailable(reason)
    }

    func events(id: String, cursor: String?, backward: Bool) async throws(ServiceFailure) -> OrchestratorEventPage {
        throw .unavailable(reason)
    }

    func createOptions(orgID: String) async throws(ServiceFailure) -> CreateOptions {
        throw .unavailable(reason)
    }

    func prepareCreate(_ request: OrchestratorCreateRequest) async throws(ServiceFailure) -> String {
        throw .unavailable(reason)
    }

    func prepareMutation(
        _ action: OrchestratorAction,
        orchestratorID: String,
        expectedRevision: Int
    ) async throws(ServiceFailure) -> String {
        throw .unavailable(reason)
    }

    func submit(handle: String) async throws(ServiceFailure) -> OperationSummary {
        throw .unavailable(reason)
    }

    func unresolved(orgID: String, orchestratorID: String?) async -> UnresolvedOperation? { nil }

    func discard(handle: String) async {}

    func settle(handle: String) async {}

    func list(orgID: String, page: Int) async throws(ServiceFailure) -> SandboxPage {
        throw .unavailable(reason)
    }

    func sandboxState(id: String, orgID: String) async throws(ServiceFailure) -> SandboxState {
        throw .unavailable(reason)
    }

    func sandboxEvents(id: String, orgID: String, cursor: String?, backward: Bool) async throws(ServiceFailure) -> OrchestratorEventPage {
        throw .unavailable(reason)
    }

    func sendPrompt(sandboxID: String, orgID: String, text: String) async throws(ServiceFailure) -> SandboxPromptAcceptance {
        throw .unavailable(reason)
    }

    func stopSandbox(id: String, orgID: String) async throws(ServiceFailure) -> SandboxStatus {
        throw .unavailable(reason)
    }
}
