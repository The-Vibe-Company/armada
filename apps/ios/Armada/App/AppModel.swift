import ArmadaKit
import Foundation
import Observation

/// An organization the signed-in person belongs to, as the presentation shows it.
struct OrganizationChoice: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    /// The CURRENT membership role reported by Armada (`admin` or `member`). Display only: the
    /// server reauthorizes every request.
    let role: String

    var roleLabel: String { role == "admin" ? "Admin" : role == "member" ? "Member" : role.capitalized }
}

/// The app-wide coordinator and the only owner of the `ArmadaKit` client. Views read its phase and
/// call its intents; no view holds a token, builds a request or decides authorization.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case restoring
        /// The build has no usable `ARMADA_API_URL`; nothing can be reached.
        case misconfigured(String)
        case signedOut
        /// Signed in, but the organizations could not be read; retry keeps the session.
        case unreachable(String)
        case choosingOrganization
        case ready
    }

    private(set) var phase: Phase = .restoring
    private(set) var organizations: [OrganizationChoice] = []
    private(set) var organization: OrganizationChoice?
    /// A short message for the sign-in screen (for example, why the session ended).
    private(set) var signInNotice: String?
    private(set) var orchestrators: any OrchestratorService
    private(set) var sandboxes: any SandboxService
    /// The signed-in person's id, once ArmadaKit publishes the account identity (`account/status`).
    /// Until then ownership is shown from server hints only, never inferred.
    private(set) var currentUserID: String?

    @ObservationIgnored private let client: ArmadaClient?

    private init(
        client: ArmadaClient?,
        phase: Phase,
        orchestrators: any OrchestratorService,
        sandboxes: any SandboxService
    ) {
        self.client = client
        self.phase = phase
        self.orchestrators = orchestrators
        self.sandboxes = sandboxes
    }

    static func live() -> AppModel {
        let unavailable = "This build has no valid Armada address. Install an official Armada build."
        guard let origin = AppConfiguration.apiOrigin(),
              let client = try? ArmadaClient(origin: origin) else {
            return AppModel(
                client: nil,
                phase: .misconfigured(unavailable),
                orchestrators: UnavailableServices.orchestrators,
                sandboxes: UnavailableServices.sandboxes
            )
        }
        return AppModel(
            client: client,
            phase: .restoring,
            orchestrators: ServiceWiring.orchestrators(client: client),
            sandboxes: ServiceWiring.sandboxes(client: client)
        )
    }

    // MARK: Session

    func restore() async {
        guard let client else { return }
        phase = .restoring
        do {
            try await client.restore()
        } catch {
            signInNotice = Self.message(for: error)
            phase = .signedOut
            return
        }
        await loadOrganizations(client: client)
    }

    func retry() async {
        guard let client else { return }
        phase = .restoring
        await loadOrganizations(client: client)
    }

    /// Sends the sign-in email. Returns a presentable error, or nil when the email is on its way.
    func startEmailLogin(email: String) async -> String? {
        guard let client else { return Self.misconfiguredMessage }
        do {
            try await client.startEmailLogin(email: email)
            signInNotice = nil
            return nil
        } catch ArmadaError.http(429) {
            return "Too many sign-in emails. Wait a moment, then try again."
        } catch ArmadaError.http(400) {
            return "Armada could not send a sign-in email to that address."
        } catch {
            return Self.message(for: error)
        }
    }

    /// Verifies the code typed from the email. Returns a presentable error, or nil once signed in.
    func verifyEmail(email: String, code: String) async -> String? {
        guard let client else { return Self.misconfiguredMessage }
        do {
            try await client.verifyEmail(email: email, code: code)
        } catch ArmadaError.signedOut {
            return "That code was not accepted. Check the latest email, or send a new code."
        } catch is CancellationError {
            return "Sign-in was interrupted. Try again."
        } catch {
            return Self.message(for: error)
        }
        signInNotice = nil
        await loadOrganizations(client: client)
        return nil
    }

    /// Clears the session on this device even when Armada cannot confirm the remote sign-out.
    func signOut() async {
        guard let client else { return }
        var notice: String?
        do {
            try await client.signOut()
        } catch ArmadaError.secureStorage {
            notice = "Signed out, but this device's secure storage reported an error."
        } catch {
            notice = "Signed out on this device. Armada could not confirm the sign-out remotely."
        }
        resetSessionState()
        signInNotice = notice
        phase = .signedOut
    }

    /// A feature saw the session end (`ServiceFailure.signedOut`).
    func sessionEnded() {
        switch phase {
        case .signedOut, .misconfigured: return
        case .restoring, .unreachable, .choosingOrganization, .ready: break
        }
        resetSessionState()
        signInNotice = "Your session ended. Sign in again."
        phase = .signedOut
    }

    // MARK: Organizations

    /// Returns a presentable error, or nil once the organization is selected.
    func select(_ choice: OrganizationChoice) async -> String? {
        guard let client else { return Self.misconfiguredMessage }
        do {
            try await client.selectOrganization(choice.id)
        } catch ArmadaError.signedOut {
            sessionEnded()
            return nil
        } catch ArmadaError.forbidden {
            await loadOrganizations(client: client)
            return "You are no longer a member of \(choice.name)."
        } catch {
            return Self.message(for: error)
        }
        organization = choice
        phase = .ready
        return nil
    }

    func chooseAnotherOrganization() {
        guard organizations.count > 1 else { return }
        phase = .choosingOrganization
    }

    private func loadOrganizations(client: ArmadaClient) async {
        let loaded: [Organization]
        do {
            loaded = try await client.organizations()
        } catch ArmadaError.signedOut {
            phase = .signedOut
            return
        } catch {
            phase = .unreachable(Self.message(for: error))
            return
        }
        organizations = loaded.map { OrganizationChoice(id: $0.id, name: $0.name, role: $0.role) }
        let selectedID = await client.selectedOrgID
        if let selectedID, let match = organizations.first(where: { $0.id == selectedID }) {
            organization = match
            phase = .ready
        } else if organizations.count == 1, let only = organizations.first {
            if let error = await select(only) {
                phase = .unreachable(error)
            }
        } else {
            organization = nil
            phase = .choosingOrganization
        }
    }

    private func resetSessionState() {
        organizations = []
        organization = nil
        currentUserID = nil
    }

    private static let misconfiguredMessage = "This build has no valid Armada address."

    /// Concise, safe text: ArmadaKit's own descriptions, never a response body or transport error.
    private static func message(for error: Error) -> String {
        if let armada = error as? ArmadaError, let description = armada.errorDescription { return description }
        return "Something went wrong. Try again."
    }
}

#if DEBUG
extension AppModel {
    /// A signed-in model for `#Preview` only, over explicit in-memory services.
    static func preview(
        phase: Phase = .ready,
        organizations: [OrganizationChoice] = PreviewData.organizations,
        orchestrators: any OrchestratorService = PreviewData.Services(),
        sandboxes: any SandboxService = PreviewData.Services()
    ) -> AppModel {
        let model = AppModel(client: nil, phase: phase, orchestrators: orchestrators, sandboxes: sandboxes)
        model.organizations = organizations
        model.organization = phase == .ready ? organizations.first : nil
        model.currentUserID = PreviewData.me
        return model
    }
}
#endif
