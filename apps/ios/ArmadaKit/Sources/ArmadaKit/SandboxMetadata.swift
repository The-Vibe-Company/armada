import Foundation

/// #680 safe organization metadata, deliberately not an interior sandbox record.
/// canOpen/canManage are UI hints: the server reauthorizes every interior operation.
public struct SandboxMetadata: Decodable, Sendable, Identifiable {
    public let id: String
    public let orgId: String
    public let ownerId: String
    public let provider: String
    public let providerSandboxId: String?
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

/// Recorded turn activity per sandbox id from `POST /api/v1/sandbox/list-turns`.
public enum RecordedTurnState: Hashable, Sendable, Decodable {
    case queued, running, finished, other(String)
    public init(rawValue: String) {
        switch rawValue {
        case "queued": self = .queued
        case "running": self = .running
        case "finished": self = .finished
        default: self = .other(rawValue)
        }
    }
    public init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }

    /// Whether a listed sandbox is working, matching dashboard `sandboxActivityPage` semantics.
    public static func isWorking(status: String, turn: RecordedTurnState?, expiresAt: Date? = nil, now: Date = .now) -> Bool {
        if status == "running" { return true }
        switch turn {
        case .queued where status == "stopped": return expiresAt.map { $0 > now } ?? true
        case .queued, .running: return status == "starting" || status == "ready"
        case .finished, .other, nil: return false
        }
    }
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

    /// `POST /api/v1/sandbox/list-turns`: recorded turn activity for sandboxes the caller can open.
    public func sandboxTurns() async throws -> [String: RecordedTurnState] {
        struct Read: Encodable, Sendable { let org: String }
        guard isSignedIn else { throw ArmadaError.signedOut }
        guard let org = selectedOrgID else { throw ArmadaError.forbidden }
        return try await post("sandbox/list-turns", Read(org: org))
    }
}
