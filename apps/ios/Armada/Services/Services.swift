import Foundation

/// The presentation's only route to orchestrators and sandboxes. Views never hold a token,
/// build a request or decide authorization: they call these services, which the app wires to
/// `ArmadaKit` (#690). Until the client publishes the corresponding requests, the runtime
/// implementation is `UnavailableServices`, an explicit unavailable capability. In-memory preview
/// data exists only inside `#Preview` blocks and is never selected at runtime.
protocol OrchestratorService: Sendable {
    func list(orgID: String, cursor: String?) async throws(ServiceFailure) -> OrchestratorPage
    func detail(id: String) async throws(ServiceFailure) -> OrchestratorDetail
    func events(id: String, cursor: String?) async throws(ServiceFailure) -> OrchestratorEventPage
    func createOptions(orgID: String) async throws(ServiceFailure) -> CreateOptions
    /// `POST /api/v1/orchestrators` with `Idempotency-Key`. A retry must reuse the same key.
    func create(
        _ request: OrchestratorCreateRequest,
        idempotencyKey: String
    ) async throws(ServiceFailure) -> OperationSummary
    /// Message, steer, stop or resume, fenced by `expectedRevision` and `Idempotency-Key`.
    func perform(
        _ action: OrchestratorAction,
        orchestratorID: String,
        expectedRevision: Int,
        idempotencyKey: String
    ) async throws(ServiceFailure) -> OperationSummary
}

protocol SandboxService: Sendable {
    /// `POST /api/v1/sandbox/list`: allowlisted metadata for every current member.
    func list(orgID: String, page: Int) async throws(ServiceFailure) -> SandboxPage
    /// Interior for the owner or a current admin; the server reauthorizes and may refuse.
    func interior(id: String, orgID: String, cursor: String?) async throws(ServiceFailure) -> SandboxInterior
}

/// Concise, safe failure categories. No raw response body or transport error reaches a view.
enum ServiceFailure: Error, Hashable, Sendable {
    /// The server or this client does not offer the capability. Shown as such; not retried in a loop.
    /// Never used for a mutation that may have been sent (that is `.uncertain`).
    case unavailable(String)
    /// The session ended. The app returns to sign-in.
    case signedOut
    /// Missing or concealed (403/404). Never pre-authorized client-side.
    case noAccess
    /// Another change won the revision fence; refresh and keep the draft.
    case staleRevision
    /// A mutation was sent but its outcome is unknown. Retry with the SAME idempotency key.
    case uncertain
    /// A read could not reach Armada. Safe to retry.
    case offline
    /// The server refused the request with a safe, presentable reason.
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

/// The runtime services while `ArmadaKit` publishes no orchestrator or sandbox requests. Every
/// call reports the explicit unavailable capability; nothing is simulated.
struct UnavailableServices: OrchestratorService, SandboxService {
    let reason: String

    static let orchestrators = UnavailableServices(
        reason: "Orchestrators aren't available yet. This app shows them once your Armada server enables them."
    )
    static let sandboxes = UnavailableServices(
        reason: "Sandboxes aren't available in this version of the app yet."
    )

    func list(orgID: String, cursor: String?) async throws(ServiceFailure) -> OrchestratorPage {
        throw .unavailable(reason)
    }

    func detail(id: String) async throws(ServiceFailure) -> OrchestratorDetail {
        throw .unavailable(reason)
    }

    func events(id: String, cursor: String?) async throws(ServiceFailure) -> OrchestratorEventPage {
        throw .unavailable(reason)
    }

    func createOptions(orgID: String) async throws(ServiceFailure) -> CreateOptions {
        throw .unavailable(reason)
    }

    func create(
        _ request: OrchestratorCreateRequest,
        idempotencyKey: String
    ) async throws(ServiceFailure) -> OperationSummary {
        throw .unavailable(reason)
    }

    func perform(
        _ action: OrchestratorAction,
        orchestratorID: String,
        expectedRevision: Int,
        idempotencyKey: String
    ) async throws(ServiceFailure) -> OperationSummary {
        throw .unavailable(reason)
    }

    func list(orgID: String, page: Int) async throws(ServiceFailure) -> SandboxPage {
        throw .unavailable(reason)
    }

    func interior(id: String, orgID: String, cursor: String?) async throws(ServiceFailure) -> SandboxInterior {
        throw .unavailable(reason)
    }
}

/// A pending mutation's identity, held by the presentation so a retry after an uncertain outcome
/// reuses the exact same request and key. A new key is only minted for a new intent.
struct PendingMutation<Request: Hashable & Sendable>: Hashable, Sendable {
    let request: Request
    let idempotencyKey: String

    init(request: Request, idempotencyKey: String = UUID().uuidString.lowercased()) {
        self.request = request
        self.idempotencyKey = idempotencyKey
    }
}
