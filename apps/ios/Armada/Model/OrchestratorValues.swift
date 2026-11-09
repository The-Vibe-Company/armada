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

    /// The design's transitions: only a ready orchestrator admits messages.
    var admitsMessages: Bool { self == .ready }
    var canStop: Bool { self == .ready || self == .blocked }
    var canResume: Bool { self == .stopped }
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
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "create": self = .create
        case "message": self = .message
        case "steer": self = .steer
        case "stop": self = .stop
        case "resume": self = .resume
        default: self = .other(rawValue)
        }
    }

    var label: String {
        switch self {
        case .create: "Create"
        case .message: "Message"
        case .steer: "Steer"
        case .stop: "Stop"
        case .resume: "Resume"
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
}

/// The owner actions the design exposes on `/api/v1/orchestrators/:id/*`.
enum OrchestratorAction: Hashable, Sendable {
    case message(String)
    case steer(String)
    case stop
    case resume

    var kind: OperationKind {
        switch self {
        case .message: .message
        case .steer: .steer
        case .stop: .stop
        case .resume: .resume
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

struct GoldenChoice: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let provider: ProviderID
    /// A golden can start an orchestrator only once its snapshot is saved.
    let isReady: Bool
    /// Repository directories recorded in the golden (`repos[].dir`).
    let repositories: [String]
}

struct ModelAccountChoice: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    /// Short safe detail, for example "Personal · Subscription". Never a credential value.
    let detail: String
    /// The harness this account can run.
    let harness: Harness
    let isDefault: Bool
}

struct ModelChoice: Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let reasoningEfforts: [String]
}

struct HarnessModels: Hashable, Sendable {
    let defaultModel: String
    let defaultReasoningEffort: String
    let reasoningEfforts: [String]
    let models: [ModelChoice]

    func efforts(for model: String) -> [String] {
        models.first { $0.id == model }?.reasoningEfforts ?? reasoningEfforts
    }
}

struct CreateOptions: Sendable {
    let goldens: [GoldenChoice]
    let accounts: [ModelAccountChoice]
    let catalog: [Harness: HarnessModels]
}

/// Exactly the fields of `OrchestratorCreate` v1. Omitted optionals are left to server defaults.
struct OrchestratorCreateRequest: Hashable, Sendable {
    let orgID: String
    let name: String
    let goldenID: String
    let provider: ProviderID
    let harness: Harness
    let repository: String?
    let model: String
    let reasoningEffort: String?
    let modelAccountID: String
    let idleSeconds: Int?
}

/// What the create form edits. Validation mirrors the server's checks so the person learns early;
/// the server still decides.
struct OrchestratorDraft: Hashable, Sendable {
    var name = ""
    var goldenID: String?
    var harness: Harness = .claude
    var model = ""
    var reasoningEffort = ""
    var accountID: String?
    var repository: String?
    var idleSeconds = IdlePolicy.defaultSeconds

    static let maximumNameLength = 80

    /// Applies the harness defaults and the first compatible default account.
    mutating func adopt(harness: Harness, options: CreateOptions) {
        self.harness = harness
        if let models = options.catalog[harness] {
            model = models.defaultModel
            reasoningEffort = models.defaultReasoningEffort
        } else {
            model = ""
            reasoningEffort = ""
        }
        let compatible = options.accounts.filter { $0.harness == harness }
        if let accountID, compatible.contains(where: { $0.id == accountID }) { return }
        accountID = (compatible.first(where: \.isDefault) ?? compatible.first)?.id
    }

    func request(orgID: String, options: CreateOptions) -> Result<OrchestratorCreateRequest, DraftProblem> {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return .failure(.missingName) }
        guard trimmedName.count <= Self.maximumNameLength else { return .failure(.nameTooLong) }
        guard let goldenID, let golden = options.goldens.first(where: { $0.id == goldenID }) else {
            return .failure(.missingGolden)
        }
        guard golden.isReady else { return .failure(.goldenNotReady) }
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedModel.isEmpty else { return .failure(.missingModel) }
        let effort = reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)
        if let models = options.catalog[harness], !effort.isEmpty,
           !models.efforts(for: trimmedModel).contains(effort) {
            return .failure(.unsupportedEffort)
        }
        guard let accountID,
              options.accounts.contains(where: { $0.id == accountID && $0.harness == harness }) else {
            return .failure(.missingAccount)
        }
        if let repository, !golden.repositories.contains(repository) {
            return .failure(.unknownRepository)
        }
        guard IdlePolicy.isValid(idleSeconds) else { return .failure(.idleOutOfRange) }
        return .success(OrchestratorCreateRequest(
            orgID: orgID,
            name: trimmedName,
            goldenID: golden.id,
            provider: golden.provider,
            harness: harness,
            repository: repository,
            model: trimmedModel,
            reasoningEffort: effort.isEmpty ? nil : effort,
            modelAccountID: accountID,
            idleSeconds: idleSeconds == IdlePolicy.defaultSeconds ? nil : idleSeconds
        ))
    }
}

enum DraftProblem: Error, Hashable, Sendable {
    case missingName
    case nameTooLong
    case missingGolden
    case goldenNotReady
    case missingModel
    case unsupportedEffort
    case missingAccount
    case unknownRepository
    case idleOutOfRange

    var message: String {
        switch self {
        case .missingName: "Name the orchestrator."
        case .nameTooLong: "Use a name of at most \(OrchestratorDraft.maximumNameLength) characters."
        case .missingGolden: "Choose a golden."
        case .goldenNotReady: "This golden has no saved snapshot yet."
        case .missingModel: "Choose a model."
        case .unsupportedEffort: "That reasoning effort is not available for this model."
        case .missingAccount: "Choose a model account for this agent."
        case .unknownRepository: "Choose a repository recorded in the golden."
        case .idleOutOfRange: "Choose an idle stop between 15 minutes and 24 hours."
        }
    }
}
