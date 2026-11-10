import Foundation

public enum OrchestratorState: String, Codable, Sendable { case creating, ready, stopping, stopped, resuming, blocked }
public enum OrchestratorContinuity: String, Codable, Sendable { case notStarted = "not_started", native, unverified, lost }
/// `recover` is a request only: its receipt is the `stop` (or `create`) operation it settles.
public enum OrchestratorAction: String, Codable, Sendable { case create, message, steer, stop, resume, recover
    /// Receipt kinds the server answers for this request.
    var receiptKinds: Set<OrchestratorAction> { self == .recover ? [.stop, .create] : [self] }
}
public enum OrchestratorOperationState: String, Codable, Sendable { case pending, succeeded, failed, uncertain }
/// Provider and harness ids are open: the server's capabilities say which exist and which pairs are
/// enabled, so a new one reaches the app without a release. The constants only name today's ids.
public struct ArmadaProvider: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init?(rawValue: String) { guard !rawValue.isEmpty else { return nil }; self.rawValue = rawValue }
    public static let boat = ArmadaProvider(rawValue: "boat")!
    public static let modal = ArmadaProvider(rawValue: "modal")!
}
public struct ArmadaHarness: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init?(rawValue: String) { guard !rawValue.isEmpty else { return nil }; self.rawValue = rawValue }
    public static let claude = ArmadaHarness(rawValue: "claude")!
    public static let codex = ArmadaHarness(rawValue: "codex")!
}

/// Canonical public wire values from merged #653 machine-size.ts. Resolution
/// stays on the server: override > explicitly selected repository > golden > legacy.
public enum MachineSize: String, Codable, Sendable, CaseIterable { case small, medium, large, xlarge }

/// Exact #661/#662 create contract including optional size from b6ca6e184f.
/// nil omits the override; it does not submit a fabricated "default" size.
public struct OrchestratorCreate: Codable, Sendable, Equatable {
    public let version: Int
    public let orgId: String
    public let name: String
    public let goldenId: String
    public let provider: ArmadaProvider
    public let harness: ArmadaHarness
    public let repo: String?
    public let size: MachineSize?
    public let model: String
    public let reasoningEffort: String?
    public let modelAccountId: String
    public let idleSeconds: Int?
    public let maxActiveChildren: Int?
    public init(orgId: String, name: String, goldenId: String, provider: ArmadaProvider,
                harness: ArmadaHarness, model: String, modelAccountId: String, repo: String? = nil,
                reasoningEffort: String? = nil, idleSeconds: Int? = nil, maxActiveChildren: Int? = nil, size: MachineSize? = nil) {
        self.version = 1; self.orgId = orgId; self.name = name; self.goldenId = goldenId
        self.provider = provider; self.harness = harness; self.model = model; self.modelAccountId = modelAccountId
        self.repo = repo; self.size = size; self.reasoningEffort = reasoningEffort; self.idleSeconds = idleSeconds
        self.maxActiveChildren = maxActiveChildren
    }
}
public struct Orchestrator: Decodable, Sendable, Identifiable {
    public let version: Int
    public let id: String
    public let ownerId: String
    public let configuration: OrchestratorCreate
    public let state: OrchestratorState
    public let revision: Int
    public let sandboxId: String?
    public let conversationId: String?
    public let continuity: OrchestratorContinuity
    public let createdAt: String
    public let updatedAt: String
    public let lastActivityAt: String
    public let idleDeadline: String?
    public let skillRevision: String
    public let blockedReason: String?
}
public struct OrchestratorOperation: Codable, Sendable, Identifiable {
    public let version: Int
    public let id: String
    public let orchestratorId: String
    public let kind: OrchestratorAction
    public let state: OrchestratorOperationState
    public let revision: Int
    public let errorCode: String?
}
public struct OrchestratorList: Decodable, Sendable {
    public let version: Int
    public let items: [Orchestrator]
    public let cursor: String?
}
public struct OrchestratorWaitLease: Decodable, Sendable, Identifiable {
    public let id: String
    public let orchestratorId: String
    public let kind: String
    public let reference: String
    public let reason: String
    public let expiresAt: String
    public let deadline: String
}
public struct OrchestratorDelegation: Decodable, Sendable, Identifiable {
    public let id: String
    public let orchestratorId: String
    public let ownerId: String
    public let orgId: String
    public let scopes: [String]
    public let expiresAt: String
    public let revokedAt: String?
    public let childPolicy: String
}
public struct OrchestratorDetail: Decodable, Sendable {
    public let version: Int
    public let orchestrator: Orchestrator
    public let operations: [OrchestratorOperation]
    public let waits: [OrchestratorWaitLease]
    public let delegation: OrchestratorDelegation?
    public let childSandboxIds: [String]
}
public struct OrchestratorCapabilities: Decodable, Sendable {
    /// One provider × harness pair as the server reports it. Only `enabled` pairs may be offered;
    /// a disabled one keeps the server's `reason` (see `OrchestratorExplanation`).
    public struct Pair: Decodable, Sendable, Equatable {
        public let provider: ArmadaProvider
        public let harness: ArmadaHarness
        public let enabled: Bool
        public let reason: String?
        /// `native` (the conversation resumes exactly) or `best_effort` (it may restart); open, so
        /// a newer level still decodes. Absent on older servers.
        public let continuity: String?
    }
    /// What a create form may offer for one harness: suggested models and efforts, and the
    /// credential kinds whose named accounts run it.
    public struct HarnessCatalog: Decodable, Sendable, Equatable {
        public struct Model: Decodable, Sendable, Equatable, Identifiable {
            public let id: String
            public let label: String
            public let reasoningEfforts: [String]
        }
        public let harness: ArmadaHarness
        public let defaultModel: String
        public let defaultReasoningEffort: String
        public let reasoningEfforts: [String]
        public let models: [Model]
        public let accountKinds: [String]
        /// A suggested model takes its own efforts; another id takes the harness's.
        public func efforts(for model: String) -> [String] {
            models.first { $0.id == model }?.reasoningEfforts ?? reasoningEfforts
        }
    }
    public let version: Int
    public let enabled: Bool
    public let reason: String?
    /// Absent on servers with no pair configured (or older ones): nothing can be created then.
    public let pairs: [Pair]?
    public let harnesses: [HarnessCatalog]?
}

/// Unknown tool payloads retain their JSON value, never reinterpret as instructions.
public enum JSONValue: Codable, Sendable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}
public struct AgentToolCall: Decodable, Sendable, Identifiable {
    public struct Result: Decodable, Sendable { public let output: JSONValue; public let isError: Bool }
    public let id: String
    public let name: String
    public let input: JSONValue?
    public let result: Result?
}
public struct AgentEvent: Decodable, Sendable, Identifiable {
    public enum Body: Sendable {
        case prompt(text: String, status: String, reason: String?)
        case message(text: String, partial: Bool, messageId: String?, textMode: String?, model: String?, tools: [AgentToolCall])
        case steer(text: String, mode: String?)
        case other(type: String, data: JSONValue)
        case unknown(kind: String, payload: JSONValue)
    }
    public let id: String
    public let at: Double
    public let conversationId: String?
    public let promptId: String?
    public let body: Body
    private enum K: String, CodingKey { case id, at, conversationId, promptId, kind, text, status, reason, partial, messageId, textMode, model, tools, mode, type, data }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id); at = try c.decode(Double.self, forKey: .at)
        conversationId = try c.decodeIfPresent(String.self, forKey: .conversationId)
        promptId = try c.decodeIfPresent(String.self, forKey: .promptId)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "prompt": body = .prompt(text: try c.decode(String.self, forKey: .text), status: try c.decode(String.self, forKey: .status), reason: try c.decodeIfPresent(String.self, forKey: .reason))
        case "message": body = .message(text: try c.decode(String.self, forKey: .text), partial: try c.decode(Bool.self, forKey: .partial), messageId: try c.decodeIfPresent(String.self, forKey: .messageId), textMode: try c.decodeIfPresent(String.self, forKey: .textMode), model: try c.decodeIfPresent(String.self, forKey: .model), tools: try c.decode([AgentToolCall].self, forKey: .tools))
        case "steer": body = .steer(text: try c.decode(String.self, forKey: .text), mode: try c.decodeIfPresent(String.self, forKey: .mode))
        // `data: unknown` is omitted from JSON when undefined; keep the event rather than fail the page.
        case "other": body = .other(type: try c.decode(String.self, forKey: .type), data: try c.decodeIfPresent(JSONValue.self, forKey: .data) ?? .null)
        default: body = .unknown(kind: kind, payload: try JSONValue(from: decoder))
        }
    }
}
public struct OrchestratorEvent: Decodable, Sendable, Identifiable {
    public enum Body: Sendable {
        case agent(AgentEvent)
        case state(OrchestratorState, OrchestratorContinuity)
        case operation(OrchestratorOperation)
        case wait(OrchestratorWaitLease, status: String)
        case child(sandboxId: String, operationId: String)
        case unknown(kind: String, payload: JSONValue)
    }
    public let id: String
    public let orchestratorId: String
    public let at: String
    public let revision: Int
    public let body: Body
    private enum K: String, CodingKey { case id, orchestratorId, at, revision, kind, event, state, continuity, operation, lease, status, sandboxId, operationId }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id); orchestratorId = try c.decode(String.self, forKey: .orchestratorId)
        at = try c.decode(String.self, forKey: .at); revision = try c.decode(Int.self, forKey: .revision)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "agent": body = .agent(try c.decode(AgentEvent.self, forKey: .event))
        case "state": body = .state(try c.decode(OrchestratorState.self, forKey: .state), try c.decode(OrchestratorContinuity.self, forKey: .continuity))
        case "operation": body = .operation(try c.decode(OrchestratorOperation.self, forKey: .operation))
        case "wait": body = .wait(try c.decode(OrchestratorWaitLease.self, forKey: .lease), status: try c.decode(String.self, forKey: .status))
        case "child": body = .child(sandboxId: try c.decode(String.self, forKey: .sandboxId), operationId: try c.decode(String.self, forKey: .operationId))
        default: body = .unknown(kind: kind, payload: try JSONValue(from: decoder))
        }
    }
}
public struct OrchestratorEventPage: Decodable, Sendable {
    public let version: Int
    public let events: [OrchestratorEvent]
    public let cursor: String?
    /// Backward reads only: continues before the oldest event of the page.
    public let olderCursor: String?
    public let hasMore: Bool
}
