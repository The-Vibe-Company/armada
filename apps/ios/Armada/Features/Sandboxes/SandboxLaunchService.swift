import ArmadaKit
import Foundation

/// Launching a sandbox (#750). Kept apart from `SandboxService` so the list, the conversation and
/// their unavailable fallback stay as they are: a service that does not launch simply does not
/// conform, and the New sandbox button explains that. The catalog, the draft and the refusal
/// mapping are ArmadaKit's pure values; this file only reaches the client.
enum SandboxLaunchDestination: Sendable {
    case conversation(SandboxSummary)
    case list
}

protocol SandboxLauncher: Sendable {
    /// `launch/options`, `golden/list` and `creds/list` for the selected organization.
    func launchCatalog(orgID: String) async throws(ServiceFailure) -> ArmadaKit.SandboxLaunchCatalog
    /// `sandbox/launch`, sent exactly once. Open the sandbox when its metadata is available.
    func launch(_ request: ArmadaKit.SandboxLaunchRequest) async throws(ArmadaKit.SandboxLaunchFailure) -> SandboxLaunchDestination
}

extension ArmadaKitServices: SandboxLauncher {
    func launchCatalog(orgID: String) async throws(ServiceFailure) -> ArmadaKit.SandboxLaunchCatalog {
        guard await client.selectedOrgID == orgID else { throw .noAccess }
        do {
            return try await client.launchCatalog()
        } catch {
            if error is CancellationError { throw .offline }
            let failure: ServiceFailure = switch ArmadaServerFailure.underlying(error) {
            case .signedOut?: .signedOut
            case .forbidden?: .noAccess
            case .http(404)?, .http(405)?, .http(501)?:
                .unavailable("This Armada server can't launch sandboxes from the app yet. Launch from the dashboard or the CLI.")
            case .unavailable?, .http(429)?: .offline
            case .invalidResponse?: .rejected("Armada returned launch options this app version doesn't understand.")
            default: .rejected("The launch options could not be read.")
            }
            throw ArmadaKitServices.explained(failure, by: error)
        }
    }

    func launch(_ request: ArmadaKit.SandboxLaunchRequest) async throws(ArmadaKit.SandboxLaunchFailure) -> SandboxLaunchDestination {
        let receipt = try await client.launchSandbox(request)
        // Use server-authorized metadata for navigation when the new row is available.
        let sandboxID = UUID(uuidString: receipt.sandboxID)
        if let row = try? await list(orgID: request.org, page: 1).items.first(where: {
            $0.orgID == request.org && UUID(uuidString: $0.id) == sandboxID
        }) {
            return row.canOpen ? .conversation(row) : .list
        }
        switch receipt {
        case .allocated(let allocation):
            return .conversation(Self.summary(allocation))
        case .admitted(let admission):
            let ownerID = await client.currentUserID ?? ""
            return .conversation(Self.summary(admission, request: request, ownerID: ownerID))
        }
    }

    /// An admitted launch receipt can open the conversation directly before `sandbox/list` catches up.
    private static func summary(
        _ admission: ArmadaKit.SandboxLaunchReceipt.Admission,
        request: ArmadaKit.SandboxLaunchRequest,
        ownerID: String
    ) -> SandboxSummary {
        SandboxSummary(
            id: admission.id,
            orgID: request.org,
            ownerID: ownerID,
            provider: ProviderID(rawValue: request.provider),
            providerSandboxID: nil,
            harness: Harness(rawValue: request.harness),
            harnessRaw: request.harness,
            model: request.model,
            reasoningEffort: request.reasoningEffort,
            status: SandboxStatus(rawValue: admission.status.rawValue),
            createdAt: Date(),
            stoppedAt: nil,
            expiresAt: nil,
            effectiveTTLSeconds: request.ttlSeconds,
            machineSize: request.size,
            displayLabel: "Sandbox \(admission.id)",
            canOpen: true,
            canManage: true
        )
    }

    /// The full launch envelope can open a conversation when the list could not be read.
    private static func summary(_ receipt: ArmadaKit.SandboxLaunchReceipt.Allocation) -> SandboxSummary {
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
