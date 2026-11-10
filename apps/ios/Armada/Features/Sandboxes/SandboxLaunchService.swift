import ArmadaKit
import Foundation

/// Launching a sandbox (#750). Kept apart from `SandboxService` so the list, the conversation and
/// their unavailable fallback stay as they are: a service that does not launch simply does not
/// conform, and the New sandbox button explains that. The catalog, the draft and the refusal
/// mapping are ArmadaKit's pure values; this file only reaches the client.
protocol SandboxLauncher: Sendable {
    /// `launch/options`, `golden/list` and `creds/list` for the selected organization.
    func launchCatalog(orgID: String) async throws(ServiceFailure) -> ArmadaKit.SandboxLaunchCatalog
    /// `sandbox/launch-sized-v1`, sent exactly once. On success, the new sandbox as the list shows it.
    func launch(_ request: ArmadaKit.SandboxLaunchRequest) async throws(ArmadaKit.SandboxLaunchFailure) -> SandboxSummary
}

extension ArmadaKitServices: SandboxLauncher {
    func launchCatalog(orgID: String) async throws(ServiceFailure) -> ArmadaKit.SandboxLaunchCatalog {
        guard await client.selectedOrgID == orgID else { throw .noAccess }
        do {
            return try await client.launchCatalog()
        } catch {
            if error is CancellationError { throw .offline }
            switch error as? ArmadaError {
            case .signedOut?: throw .signedOut
            case .forbidden?: throw .noAccess
            case .http(404)?, .http(405)?, .http(501)?:
                throw .unavailable("This Armada server can't launch sandboxes from the app yet. Launch from the dashboard or the CLI.")
            case .unavailable?, .http(429)?: throw .offline
            case .invalidResponse?: throw .rejected("Armada returned launch options this app version doesn't understand.")
            default: throw .rejected("The launch options could not be read.")
            }
        }
    }

    func launch(_ request: ArmadaKit.SandboxLaunchRequest) async throws(ArmadaKit.SandboxLaunchFailure) -> SandboxSummary {
        let receipt = try await client.launchSandbox(request)
        // The list row carries the server's own label and permission hints; read it when it is there.
        if let row = try? await list(orgID: request.org, page: 1).items.first(where: { $0.id == receipt.sandbox.id }) {
            return row
        }
        return Self.summary(receipt)
    }

    /// The new sandbox from the launch answer alone, when the list could not be read. The person
    /// launched it, so they own it; the server still reauthorizes every read.
    private static func summary(_ receipt: ArmadaKit.SandboxLaunchReceipt) -> SandboxSummary {
        let sandbox = receipt.sandbox
        let parse: (String) -> Date? = { value in
            (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value)) ?? (try? Date.ISO8601FormatStyle().parse(value))
        }
        return SandboxSummary(
            id: sandbox.id,
            orgID: sandbox.orgId,
            ownerID: sandbox.ownerId,
            provider: ProviderID(rawValue: sandbox.provider),
            providerSandboxID: sandbox.providerSandboxId,
            harness: Harness(rawValue: sandbox.harness),
            harnessRaw: sandbox.harness,
            model: sandbox.model,
            reasoningEffort: sandbox.reasoningEffort,
            status: SandboxStatus(rawValue: sandbox.status),
            createdAt: parse(sandbox.createdAt) ?? Date(),
            stoppedAt: nil,
            expiresAt: sandbox.expiresAt.flatMap(parse),
            effectiveTTLSeconds: sandbox.effectiveTtlSeconds ?? receipt.ttlSeconds,
            machineSize: nil,
            displayLabel: "Sandbox \(sandbox.id)",
            canOpen: true,
            canManage: true
        )
    }
}
