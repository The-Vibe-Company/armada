import Foundation

/// #680 safe organization metadata, deliberately not an interior sandbox record.
/// canOpen/canManage are UI hints: the server reauthorizes every interior operation.
public struct SandboxMetadata: Decodable, Sendable, Identifiable {
    public let id: String
    public let orgId: String
    public let ownerId: String
    public let provider: String
    public let providerSandboxId: String?
    public let boatId: String?
    public let harness: String
    public let model: String?
    public let reasoningEffort: String?
    public let status: String
    public let createdAt: String
    public let stoppedAt: String?
    public let expiresAt: String?
    public let effectiveTtlSeconds: Int?
    public let machineSize: String?
    public let displayLabel: String
    public let canOpen: Bool
    public let canManage: Bool
}
public struct SandboxMetadataPage: Decodable, Sendable {
    public let sandboxes: [SandboxMetadata]
    public let total: Int
    public let page: Int
    public let limit: Int
    public let hasMore: Bool
    public let nextPage: Int?
}

extension ArmadaClient {
    /// Requires #680 backend deployment. One metadata request only; never enriches
    /// rows via detail/status, even when the current member cannot open them.
    public func sandboxMetadata(page: Int = 1, limit: Int = 25) async throws -> SandboxMetadataPage {
        struct List: Encodable, Sendable { let org: String; let page: Int; let limit: Int }
        guard let org = selectedOrgID else { throw ArmadaError.forbidden }
        guard (1...1_000_000).contains(page), (1...200).contains(limit) else { throw ArmadaError.invalidResponse }
        return try await post("sandbox/list", List(org: org, page: page, limit: limit))
    }
}
