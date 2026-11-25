import ArmadaKit
import Foundation

/// Presentation services over the authenticated ArmadaKit client.
protocol SandboxService: Sendable {
    /// `POST /api/v1/sandbox/list`: allowlisted metadata for every current member.
    func list(orgID: String, page: Int) async throws(ServiceFailure) -> SandboxPage
    /// `POST /api/v1/sandbox/list-turns`: recorded turn activity for sandboxes the caller can open.
    func listTurns(orgID: String) async throws(ServiceFailure) -> [String: RecordedTurnState]
    /// `POST /api/v1/sandbox/status`: interior state for the owner or a current admin. The server
    /// reauthorizes every call and may refuse (`.noAccess`).
    func sandboxState(id: String, orgID: String) async throws(ServiceFailure) -> SandboxState
    /// `POST /api/v1/logs/read`: one page of the conversation after an opaque cursor; `backward`
    /// reads the latest page, or the one before an older cursor (#812).
    func sandboxEvents(id: String, orgID: String, cursor: String?, backward: Bool) async throws(ServiceFailure) -> ConversationEventPage
    /// `POST /api/v1/sandbox/send`: sent exactly once. `.uncertain` means it may have been
    /// delivered; it is never resent automatically because native providers ignore its request_id.
    func sendPrompt(sandboxID: String, orgID: String, text: String) async throws(ServiceFailure) -> SandboxPromptAcceptance
    /// `POST /api/v1/sandbox/steer`: redirects the running turn without starting a queued turn.
    func steerSandbox(sandboxID: String, orgID: String, text: String) async throws(ServiceFailure) -> SandboxSteerAcceptance
    /// `POST /api/v1/sandbox/interrupt`: interrupts the running turn while keeping the machine up.
    func interruptSandbox(id: String, orgID: String) async throws(ServiceFailure) -> SandboxInterruptOutcome
    /// `POST /api/v1/sandbox/stop`: reports whether work retention needs attention.
    func stopSandbox(id: String, orgID: String) async throws(ServiceFailure) -> SandboxStopOutcome
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
    /// `transientWhileStarting` marks HTTP 400/409 read refusals that clear once a starting sandbox is ready.
    case rejected(String, transientWhileStarting: Bool = false)

    indirect case explained(ServiceFailure, String)

    enum Category { case unavailable, signedOut, noAccess, uncertain, offline, rejected }
    var category: Category {
        switch self {
        case .explained(let cause, _): cause.category
        case .unavailable: .unavailable
        case .signedOut: .signedOut
        case .noAccess: .noAccess
        case .uncertain: .uncertain
        case .offline: .offline
        case .rejected: .rejected
        }
    }

    var isTransientWhileStarting: Bool {
        switch self {
        case .explained(let cause, _): cause.isTransientWhileStarting
        case .rejected(_, let transient): transient
        default: false
        }
    }

    var message: String {
        switch self {
        case .explained(_, let reason): reason
        case .unavailable(let reason): reason
        case .signedOut: "Your session ended. Sign in again."
        case .noAccess: "You don't have access to this, or it no longer exists."
        case .uncertain: "Armada did not confirm this request. Check the conversation before sending it again."
        case .offline: "Armada can't be reached. Check your connection."
        case .rejected(let reason, _): reason
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

    func listTurns(orgID: String) async throws(ServiceFailure) -> [String: RecordedTurnState] { throw .unavailable(reason) }

    func sandboxState(id: String, orgID: String) async throws(ServiceFailure) -> SandboxState {
        throw .unavailable(reason)
    }

    func sandboxEvents(id: String, orgID: String, cursor: String?, backward: Bool) async throws(ServiceFailure) -> ConversationEventPage {
        throw .unavailable(reason)
    }

    func sendPrompt(sandboxID: String, orgID: String, text: String) async throws(ServiceFailure) -> SandboxPromptAcceptance {
        throw .unavailable(reason)
    }

    func steerSandbox(sandboxID: String, orgID: String, text: String) async throws(ServiceFailure) -> SandboxSteerAcceptance { throw .unavailable(reason) }
    func interruptSandbox(id: String, orgID: String) async throws(ServiceFailure) -> SandboxInterruptOutcome { throw .unavailable(reason) }

    func stopSandbox(id: String, orgID: String) async throws(ServiceFailure) -> SandboxStopOutcome {
        throw .unavailable(reason)
    }
}
