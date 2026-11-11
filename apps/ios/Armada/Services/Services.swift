import Foundation

/// Presentation services over the authenticated ArmadaKit client.
protocol SandboxService: Sendable {
    /// `POST /api/v1/sandbox/list`: allowlisted metadata for every current member.
    func list(orgID: String, page: Int) async throws(ServiceFailure) -> SandboxPage
    /// `POST /api/v1/sandbox/detail`: interior state for the owner or a current admin. The server
    /// reauthorizes every call and may refuse (`.noAccess`).
    func sandboxState(id: String, orgID: String) async throws(ServiceFailure) -> SandboxState
    /// `POST /api/v1/logs/read`: one page of the conversation after an opaque cursor; `backward`
    /// reads the latest page, or the one before an older cursor (#812).
    func sandboxEvents(id: String, orgID: String, cursor: String?, backward: Bool) async throws(ServiceFailure) -> ConversationEventPage
    /// `POST /api/v1/sandbox/send`: sent exactly once. `.uncertain` means it may have been
    /// delivered; it is never resent automatically because the route has no idempotency key.
    func sendPrompt(sandboxID: String, orgID: String, text: String) async throws(ServiceFailure) -> SandboxPromptAcceptance
    /// `POST /api/v1/sandbox/stop`: the disk and conversations are kept. Safe to repeat.
    func stopSandbox(id: String, orgID: String) async throws(ServiceFailure) -> SandboxStatus
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
    /// A command was sent but its outcome is unknown. Do not resend automatically.
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
        case .uncertain: "Armada did not confirm this request. Check the conversation before sending it again."
        case .offline: "Armada can't be reached. Check your connection."
        case .rejected(let reason): reason
        }
    }
}

/// Services for a build with no usable client (for example, a missing `ARMADA_API_URL`). Every
/// call reports the explicit unavailable capability; nothing is simulated.
struct UnavailableServices: SandboxService {
    let reason: String

    static let sandboxes = UnavailableServices(reason: "Sandboxes aren't available in this build.")

    func list(orgID: String, page: Int) async throws(ServiceFailure) -> SandboxPage {
        throw .unavailable(reason)
    }

    func sandboxState(id: String, orgID: String) async throws(ServiceFailure) -> SandboxState {
        throw .unavailable(reason)
    }

    func sandboxEvents(id: String, orgID: String, cursor: String?, backward: Bool) async throws(ServiceFailure) -> ConversationEventPage {
        throw .unavailable(reason)
    }

    func sendPrompt(sandboxID: String, orgID: String, text: String) async throws(ServiceFailure) -> SandboxPromptAcceptance {
        throw .unavailable(reason)
    }

    func stopSandbox(id: String, orgID: String) async throws(ServiceFailure) -> SandboxStatus {
        throw .unavailable(reason)
    }
}
