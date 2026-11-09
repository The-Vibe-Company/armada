import Foundation

/// One row of the organization sandbox list: exactly the allowlisted `SandboxListMetadata` v1 of
/// `docs/contracts/sandbox-access-v1.md` (#680). Every current member may list it. It carries no
/// conversation, prompt, repository, golden configuration, raw failure or credential material,
/// and this type must never be extended from an interior record.
struct SandboxSummary: Identifiable, Hashable, Sendable {
    let id: String
    let orgID: String
    let ownerID: String
    let provider: ProviderID
    /// Canonical provider display id (`bx_…` on Boat). Display metadata, not a credential or route.
    let providerSandboxID: String?
    let harness: Harness?
    let harnessRaw: String
    let model: String?
    let reasoningEffort: String?
    let status: SandboxStatus
    let createdAt: Date
    let stoppedAt: Date?
    let expiresAt: Date?
    let effectiveTTLSeconds: Int?
    /// Effective size only (`small`, `medium`, `large`, `xlarge`).
    let machineSize: String?
    /// Generated from the logical id, never the source golden's name.
    let displayLabel: String
    /// UI hints derived server-side from CURRENT membership. Every interior read or operation is
    /// reauthorized by the server, which may still refuse it.
    let canOpen: Bool
    let canManage: Bool

    var agentLabel: String { harness?.label ?? harnessRaw }
}

struct SandboxPage: Sendable {
    let items: [SandboxSummary]
    let total: Int
    /// 1-based page to request next; nil at the end.
    let nextPage: Int?
}

/// The interior a permitted owner or current admin may open. Built only from a server response to
/// an authorized interior request, never from list metadata.
struct SandboxInterior: Sendable {
    let summary: SandboxSummary
    let events: [OrchestratorEvent]
    /// Opaque cursor to continue the event stream.
    let cursor: String?
    /// The server accepts a message for this sandbox now.
    let acceptsMessages: Bool
}
