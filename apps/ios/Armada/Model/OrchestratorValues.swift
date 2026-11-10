import ArmadaKit
import Foundation

/// Presentation values for the persistent orchestrator surface. Every field maps one-to-one to the
/// versioned wire contract in `packages/core/src/orchestrator.ts` (v1); the client adapter owns the
/// decoding. Unknown states are preserved, never treated as a known working state.
enum OrchestratorState: Hashable, Sendable {
    case creating
    case ready
    case stopping
    case stopped
    case resuming
    case blocked
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "creating": self = .creating
        case "ready": self = .ready
        case "stopping": self = .stopping
        case "stopped": self = .stopped
        case "resuming": self = .resuming
        case "blocked": self = .blocked
        default: self = .other(rawValue)
        }
    }

    var label: String {
        switch self {
        case .creating: "Starting"
        case .ready: "Ready"
        case .stopping: "Stopping"
        case .stopped: "Stopped"
        case .resuming: "Resuming"
        case .blocked: "Needs attention"
        case .other(let value): value.capitalized
        }
    }

    var tone: StatusTone {
        switch self {
        case .ready: .ready
        case .creating, .stopping, .resuming: .transitioning
        case .blocked: .error
        case .stopped, .other: .inactive
        }
    }

    /// The wire value, for ArmadaKit's pure rules (`OrchestratorControls`, `OrchestratorPolling`).
    var rawValue: String {
        switch self {
        case .creating: "creating"
        case .ready: "ready"
        case .stopping: "stopping"
        case .stopped: "stopped"
        case .resuming: "resuming"
        case .blocked: "blocked"
        case .other(let value): value
        }
    }
}

enum OrchestratorContinuity: Hashable, Sendable {
    case notStarted
    case native
    case unverified
    case lost
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "not_started": self = .notStarted
        case "native": self = .native
        case "unverified": self = .unverified
        case "lost": self = .lost
        default: self = .other(rawValue)
        }
    }

    var label: String {
        switch self {
        case .notStarted: "Not started"
        case .native: "Native conversation"
        case .unverified: "Unverified"
        case .lost: "Conversation lost"
        case .other(let value): value
        }
    }

    var explanation: String {
        switch self {
        case .notStarted:
            "The first message starts the agent's native conversation."
        case .native:
            "Stopping and resuming keeps this exact conversation."
        case .unverified:
            "Armada could not verify the saved conversation. It will not resume until it is verified."
        case .lost:
            "The saved conversation no longer exists. Start a new orchestrator to continue; this history stays readable."
        case .other:
            "This app does not know this continuity state yet."
        }
    }

    var rawValue: String {
        switch self {
        case .notStarted: "not_started"
        case .native: "native"
        case .unverified: "unverified"
        case .lost: "lost"
        case .other(let value): value
        }
    }
}

struct OrchestratorSummary: Identifiable, Hashable, Sendable {
    let id: String
    let ownerID: String
    let orgID: String
    let name: String
    let goldenID: String
    let provider: ProviderID
    let harness: Harness?
    /// Raw harness string when this build does not know it.
    let harnessRaw: String
    let model: String
    let reasoningEffort: String?
    let modelAccountID: String
    let repository: String?
    let idleSeconds: Int?
    let maxActiveChildren: Int?
    let state: OrchestratorState
    /// CAS revision every fenced mutation sends as `expectedRevision`.
    let revision: Int
    let sandboxID: String?
    let continuity: OrchestratorContinuity
    let createdAt: Date
    let updatedAt: Date
    let lastActivityAt: Date
    let idleDeadline: Date?
    let blockedReason: String?

    var agentLabel: String { harness?.label ?? harnessRaw }

    /// The blocked reason as a plain sentence; the server's code is never shown alone.
    var blockedExplanation: String? {
        blockedReason.map { ArmadaKit.OrchestratorExplanation.text(for: $0) }
    }

    var modelLine: String {
        guard let reasoningEffort, !reasoningEffort.isEmpty else { return model }
        return "\(model) · \(reasoningEffort)"
    }
}

struct OrchestratorPage: Sendable {
    let items: [OrchestratorSummary]
    /// Opaque server cursor for the next page; nil at the end.
    let cursor: String?
}

enum OperationKind: Hashable, Sendable {
    case create
    case message
    case steer
    case stop
    case resume
    /// A request only: its receipt is the stop (or create) it settles.
    case recover
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "create": self = .create
        case "message": self = .message
        case "steer": self = .steer
        case "stop": self = .stop
        case "resume": self = .resume
        case "recover": self = .recover
        default: self = .other(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .create: "create"
        case .message: "message"
        case .steer: "steer"
        case .stop: "stop"
        case .resume: "resume"
        case .recover: "recover"
        case .other(let value): value
        }
    }

    var label: String {
        switch self {
        case .create: "Create"
        case .message: "Message"
        case .steer: "Steer"
        case .stop: "Stop"
        case .resume: "Resume"
        case .recover: "Recovery"
        case .other(let value): value.capitalized
        }
    }
}

enum OperationState: Hashable, Sendable {
    case pending
    case succeeded
    case failed
    /// The server could not confirm the outcome; it reconciles under the same receipt.
    case uncertain
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "pending": self = .pending
        case "succeeded": self = .succeeded
        case "failed": self = .failed
        case "uncertain": self = .uncertain
        default: self = .other(rawValue)
        }
    }

    var isOpen: Bool { self == .pending || self == .uncertain }

    var rawValue: String {
        switch self {
        case .pending: "pending"
        case .succeeded: "succeeded"
        case .failed: "failed"
        case .uncertain: "uncertain"
        case .other(let value): value
        }
    }
}

struct OperationSummary: Identifiable, Hashable, Sendable {
    let id: String
    let orchestratorID: String
    let kind: OperationKind
    let state: OperationState
    let revision: Int
    /// Stable safe code, never a raw provider exception.
    let errorCode: String?
}

struct WaitLease: Identifiable, Hashable, Sendable {
    let id: String
    /// `ci`, `child`, `external` or `task`.
    let kind: String
    let reference: String
    let reason: String
    let expiresAt: Date
    /// Absolute cap across renewals.
    let deadline: Date
}

/// Delegation metadata only. Armada never sends the delegated token to a client.
struct DelegationSummary: Hashable, Sendable {
    let scopes: [String]
    let expiresAt: Date
    let revokedAt: Date?
}

struct OrchestratorDetail: Sendable {
    let summary: OrchestratorSummary
    let operations: [OperationSummary]
    let waits: [WaitLease]
    let delegation: DelegationSummary?
    let childSandboxIDs: [String]

    var openOperations: [OperationSummary] { operations.filter(\.state.isOpen) }

    /// What may be done now (ArmadaKit's rule, the dashboard's too). `agentWorking`: a turn runs.
    func controls(agentWorking: Bool) -> ArmadaKit.OrchestratorControls {
        ArmadaKit.OrchestratorControls(
            state: summary.state.rawValue,
            continuity: summary.continuity.rawValue,
            blockedReason: summary.blockedReason,
            revision: summary.revision,
            operations: operations.map { (kind: $0.kind.rawValue, state: $0.state.rawValue, revision: $0.revision, errorCode: $0.errorCode) },
            agentWorking: agentWorking
        )
    }

    /// Where its create stands: nothing is sent before it has succeeded.
    var createProgress: ArmadaKit.OrchestratorCreateProgress {
        ArmadaKit.OrchestratorCreateProgress(
            state: summary.state.rawValue,
            operations: operations.map { (kind: $0.kind.rawValue, state: $0.state.rawValue, errorCode: $0.errorCode) },
            blockedReason: summary.blockedReason
        )
    }
}

/// The owner actions the design exposes on `/api/v1/orchestrators/:id/*`.
enum OrchestratorAction: Hashable, Sendable {
    case message(String)
    case steer(String)
    case stop
    case resume
    case recover

    var kind: OperationKind {
        switch self {
        case .message: .message
        case .steer: .steer
        case .stop: .stop
        case .resume: .resume
        case .recover: .recover
        }
    }
}

// MARK: - Inactivity

/// The design's idle-stop policy (`ORCHESTRATOR_DEFAULTS`): 2 h by default, 15 min to 24 h
/// inclusive. The server is the authority; the app only offers values inside the range.
enum IdlePolicy {
    static let defaultSeconds = 7_200
    static let minimumSeconds = 900
    static let maximumSeconds = 86_400

    static let choices: [Int] = [900, 1_800, 3_600, 7_200, 14_400, 28_800, 43_200, 86_400]

    static func isValid(_ seconds: Int) -> Bool {
        seconds >= minimumSeconds && seconds <= maximumSeconds
    }

    static func label(_ seconds: Int) -> String {
        if seconds % 3_600 == 0 {
            let hours = seconds / 3_600
            return hours == 1 ? "1 hour" : "\(hours) hours"
        }
        return "\(seconds / 60) min"
    }
}

// MARK: - Creation

/// What the create form may offer, entirely from the server: ArmadaKit's catalog filters goldens,
/// provider × harness pairs (enabled ones only, disabled ones explained), models and accounts.
struct CreateOptions: Sendable {
    let catalog: ArmadaKit.OrchestratorCreateCatalog
}

/// The exact `OrchestratorCreate` v1 the person confirmed. Omitted optionals keep server defaults.
struct OrchestratorCreateRequest: Sendable {
    let configuration: ArmadaKit.OrchestratorCreate
    var orgID: String { configuration.orgId }
    var name: String { configuration.name }
}

/// Display names for an open harness id: today's known ones by name, any other as sent.
enum HarnessName {
    static func label(_ raw: String) -> String { Harness(rawValue: raw)?.label ?? raw }
}
