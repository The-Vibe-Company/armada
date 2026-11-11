import Foundation
import ArmadaKit

/// Local continuity only: never resubmits a saved prompt.
protocol SandboxPromptRecovery: Sendable {
    func unconfirmedPrompt(sandboxID: String, orgID: String) async throws(ServiceFailure) -> ArmadaKit.PendingSandboxPrompt?
    func dismissPrompt(id: UUID, orgID: String) async throws(ServiceFailure)
}

extension ArmadaKitServices: SandboxPromptRecovery {
    func unconfirmedPrompt(sandboxID: String, orgID: String) async throws(ServiceFailure) -> ArmadaKit.PendingSandboxPrompt? {
        guard await client.selectedOrgID == orgID else { throw .noAccess }
        do { return try await client.unconfirmedSandboxPrompt(id: sandboxID) }
        catch { throw .rejected("The saved prompt could not be read from this device.") }
    }

    func dismissPrompt(id: UUID, orgID: String) async throws(ServiceFailure) {
        guard await client.selectedOrgID == orgID else { throw .noAccess }
        do { try await client.dismissSandboxPrompt(id: id) }
        catch { throw .rejected("The saved prompt could not be dismissed. Its local tracking is kept.") }
    }
}
