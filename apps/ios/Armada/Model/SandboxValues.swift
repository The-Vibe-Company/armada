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

/// Interior state of a sandbox the server let this person open (owner or current admin), read from
/// `sandbox/detail`. Built only from an authorized interior response, never from list metadata.
struct SandboxState: Hashable, Sendable {
    enum Admission: Hashable, Sendable {
        /// A new prompt can be sent now (a stopped sandbox resumes on it).
        case open
        case turnRunning
        case starting
        case stopping
        case failed
        case deleted
        case unknownStatus
    }

    let status: SandboxStatus
    /// Safe server-written reason, for example why the sandbox failed.
    let statusReason: String?
    /// The latest turn, if any.
    let turn: SandboxTurnState?
    let admission: Admission
    let canStop: Bool
    let isWorking: Bool
}

struct SandboxTurnState: Hashable, Sendable {
    let promptID: String
    let status: PromptStatus
    let reason: String?
    var requestedModel: String? = nil
    var observedModel: String? = nil
    var modelSelectionReason: String? = nil
    var modelSelectionMessage: String? = nil
}

/// The server's acceptance of a prompt: the turn it opened.
struct SandboxPromptAcceptance: Hashable, Sendable {
    let promptID: String
    let status: PromptStatus
}
