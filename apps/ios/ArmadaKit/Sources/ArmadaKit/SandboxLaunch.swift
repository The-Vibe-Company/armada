import Foundation

// MARK: Server catalogs

/// `POST /api/v1/launch/options`: the server's own harness, model, effort, credential-kind,
/// machine-size and TTL catalogs. The app offers exactly these and keeps no list of its own; an
/// unknown harness, model or size is offered with its raw id.
public struct LaunchOptions: Decodable, Sendable, Equatable {
    public struct Model: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let label: String
        /// Lowest first.
        public let reasoningEfforts: [String]
    }

    public struct Harness: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let defaultModel: String
        public let defaultReasoningEffort: String
        /// Every effort the harness knows: what a model outside `models` may ask for.
        public let reasoningEfforts: [String]
        public let models: [Model]
        /// The credential kinds (`creds/list` `kind`) this harness runs on.
        public let credentialKinds: [String]

        public func efforts(for model: String) -> [String] {
            models.first { $0.id == model }?.reasoningEfforts ?? reasoningEfforts
        }
    }

    public struct Provider: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let enabled: Bool
        public let launchSources: [String]
        public let harnesses: [String]
        public let capabilities: [String: Bool]
        public let unsupportedReasons: [String: String]
    }

    public struct TTL: Decodable, Sendable, Equatable {
        public let defaultSeconds: Int
        /// The longest TTL each provider accepts, by provider id.
        public let maxSeconds: [String: Int]
    }

    public let harnesses: [Harness]
    public let machineSizes: [String]
    public let ttl: TTL
    public let providers: [Provider]
}

/// One golden of `POST /api/v1/golden/list`, already filtered by the server to what the caller may
/// see (org goldens and their own private ones). Only what the launch form needs is decoded.
public struct LaunchGolden: Decodable, Sendable, Equatable, Identifiable {
    public struct Repository: Decodable, Sendable, Equatable {
        public let url: String
        public let branch: String
        public let dir: String
    }

    public struct Config: Decodable, Sendable, Equatable {
        public let repos: [Repository]
    }

    public let id: String
    public let name: String
    public let provider: String
    public let orgId: String
    public let visibility: String
    public let ownerId: String
    /// Null until the golden has a saved snapshot; a launch needs one.
    public let providerSnapshotId: String?
    public let config: Config

    public var isReady: Bool { providerSnapshotId != nil }
}

struct LaunchGoldenList: Decodable, Sendable { let goldens: [LaunchGolden] }

/// A model account a launch can name (`credentialId`), from `POST /api/v1/creds/list`. No value,
/// token or auth state is decoded.
public struct LaunchAccount: Sendable, Equatable, Identifiable {
    public enum Scope: String, Sendable, Equatable { case user, org }
    public let id: String
    public let name: String
    public let kind: String
    public let scope: Scope
    public let isDefault: Bool
    /// `active`, `revoked`, `deleted` or another value read as not working.
    public let status: String
    public let expiresAt: Date?

    public init(id: String, name: String, kind: String, scope: Scope, isDefault: Bool, status: String, expiresAt: Date?) {
        self.id = id; self.name = name; self.kind = kind; self.scope = scope
        self.isDefault = isDefault; self.status = status; self.expiresAt = expiresAt
    }

    /// Why a launch cannot run on it now, in a word, or nil when it can.
    public func problem(now: Date) -> String? {
        switch status {
        case "active": break
        case "revoked": return "revoked"
        case "deleted": return "removed"
        default: return "status unknown"
        }
        if let expiresAt, expiresAt <= now { return "expired" }
        return nil
    }
}

struct LaunchCredentialList: Decodable, Sendable {
    struct Row: Decodable, Sendable {
        let id: String?
        let name: String?
        let isDefault: Bool?
        let status: String?
        let expiresAt: String?
        let kind: String
    }

    struct Org: Decodable, Sendable {
        let id: String
        let credentials: [Row]
    }

    let user: [Row]
    let orgs: [Org]

    /// Named accounts of the person and of `orgID`. Rows without an id (a provider key, a legacy
    /// singleton) cannot be named by a launch and are left to the server's own resolution.
    func accounts(orgID: String) -> [LaunchAccount] {
        func named(_ rows: [Row], scope: LaunchAccount.Scope) -> [LaunchAccount] {
            rows.compactMap { row in
                guard let id = row.id, UUID(uuidString: id) != nil else { return nil }
                let status = row.status ?? "active"
                guard status != "deleted" else { return nil }
                return LaunchAccount(
                    id: id,
                    name: row.name?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? row.kind,
                    kind: row.kind,
                    scope: scope,
                    isDefault: row.isDefault == true,
                    status: status,
                    expiresAt: row.expiresAt.flatMap(LaunchDates.parse)
                )
            }
        }
        return named(user, scope: .user) + named(orgs.filter { $0.id == orgID }.flatMap(\.credentials), scope: .org)
    }
}

enum LaunchDates {
    static func parse(_ value: String) -> Date? {
        if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value) { return date }
        return try? Date.ISO8601FormatStyle().parse(value)
    }
}

extension String {
    fileprivate var nonEmpty: String? { isEmpty ? nil : self }
}

// MARK: Options for the form

/// What the New sandbox form may offer in one organization, derived from the server's answers.
/// Pure: the form reads it, the draft validates against it, and the server still decides.
public struct SandboxLaunchCatalog: Sendable, Equatable {
    public let orgID: String
    public let options: LaunchOptions
    /// Every golden of the organization the person can see, ready ones first, then by name.
    public let goldens: [LaunchGolden]
    public let accounts: [LaunchAccount]

    public init(orgID: String, options: LaunchOptions, goldens: [LaunchGolden], accounts: [LaunchAccount]) {
        self.orgID = orgID
        self.options = options
        self.goldens = goldens
            .filter { $0.orgId == orgID }
            .sorted { lhs, rhs in
                if lhs.isReady != rhs.isReady { return lhs.isReady }
                let order = lhs.name.localizedStandardCompare(rhs.name)
                return order == .orderedSame ? lhs.provider < rhs.provider : order == .orderedAscending
            }
        self.accounts = accounts
    }

    public var harnesses: [LaunchOptions.Harness] { options.harnesses }

    public func provider(_ id: String) -> LaunchOptions.Provider? { options.providers.first { $0.id == id } }

    /// Harnesses the selected golden's provider accepts, in server catalog order.
    public func harnesses(for golden: LaunchGolden?) -> [LaunchOptions.Harness] {
        guard let golden, let provider = provider(golden.provider) else { return options.harnesses }
        let allowed = Set(provider.harnesses)
        return options.harnesses.filter { allowed.contains($0.id) }
    }

    public func harness(_ id: String) -> LaunchOptions.Harness? { options.harnesses.first { $0.id == id } }

    public func golden(_ id: String?) -> LaunchGolden? { id.flatMap { id in goldens.first { $0.id == id } } }

    /// The provider is shown with the golden when the same name exists on several providers.
    public func needsProviderLabel(_ golden: LaunchGolden) -> Bool {
        goldens.contains { $0.id != golden.id && $0.name == golden.name }
    }

    /// The accounts of this harness, the person's first: the order the server resolves them.
    public func accounts(for harness: String) -> [LaunchAccount] {
        let kinds = Set(self.harness(harness)?.credentialKinds ?? [])
        let compatible = accounts.filter { kinds.contains($0.kind) }
        return compatible.filter { $0.scope == .user } + compatible.filter { $0.scope == .org }
    }

    /// The account the server would use when none is named (#603): the personal default, the only
    /// personal account, the org default, the only org account. Several and no default is
    /// `ambiguous`: the person chooses; no billing account is picked for them.
    public func defaultAccount(for harness: String) -> DefaultAccount {
        let compatible = accounts(for: harness)
        for scope in [LaunchAccount.Scope.user, .org] {
            let rows = compatible.filter { $0.scope == scope }
            if let pick = rows.first(where: \.isDefault) ?? (rows.count == 1 ? rows.first : nil) { return .account(pick) }
            if rows.count > 1 { return .ambiguous }
        }
        return .none
    }

    public enum DefaultAccount: Sendable, Equatable {
        case account(LaunchAccount)
        case ambiguous
        case none
    }

    /// The account picker is shown only when there is a real choice.
    public func offersAccountChoice(for harness: String) -> Bool { accounts(for: harness).count > 1 }

    /// Repository directories recorded in the golden. A choice is offered only when there is more than one.
    public func repositories(of golden: LaunchGolden) -> [String] { golden.config.repos.map(\.dir) }

    public func offersRepositoryChoice(for golden: LaunchGolden) -> Bool { golden.config.repos.count > 1 }

    /// The sizes the server accepts; empty means no choice is offered and the golden's default applies.
    public var machineSizes: [String] { options.machineSizes }

    public var defaultTTLSeconds: Int { options.ttl.defaultSeconds }

    /// The longest TTL the golden's provider accepts, or nil when the server did not say.
    public func maxTTLSeconds(for golden: LaunchGolden?) -> Int? {
        golden.flatMap { options.ttl.maxSeconds[$0.provider] }
    }

    /// TTL presets within the provider's limit, always including the server default.
    public func ttlChoices(for golden: LaunchGolden?) -> [Int] {
        let presets = [3_600, 4 * 3_600, 8 * 3_600, 24 * 3_600, 3 * 86_400, 7 * 86_400, 30 * 86_400]
        let limit = maxTTLSeconds(for: golden) ?? defaultTTLSeconds
        return Array(Set(presets.filter { $0 <= limit } + [defaultTTLSeconds])).sorted()
    }
}

// MARK: Draft and request

/// What the New sandbox form edits. Validation mirrors the server's checks so the person learns
/// early; the server still decides. A refusal keeps every field.
public struct SandboxLaunchDraft: Sendable, Equatable {
    public var goldenID: String?
    public var harness: String = ""
    public var model: String = ""
    public var reasoningEffort: String = ""
    /// nil: the server resolves the account (only when the person has no choice to make).
    public var accountID: String?
    /// nil: the golden's default repository context.
    public var repository: String?
    /// nil: the golden's default machine size.
    public var size: String?
    public var ttlSeconds: Int
    public var prompt: String = ""

    /// A draft on the first ready golden and its first supported harness, with the server's defaults.
    public init(catalog: SandboxLaunchCatalog) {
        ttlSeconds = catalog.defaultTTLSeconds
        let initialGolden = catalog.goldens.first(where: \.isReady) ?? catalog.goldens.first
        goldenID = initialGolden?.id
        if let first = catalog.harnesses(for: initialGolden).first { adopt(harness: first.id, catalog: catalog) }
    }

    /// Applies the harness's default model and effort, and the account the server would pick.
    public mutating func adopt(harness: String, catalog: SandboxLaunchCatalog) {
        self.harness = harness
        if let options = catalog.harness(harness) {
            model = options.defaultModel
            reasoningEffort = options.defaultReasoningEffort
        } else {
            model = ""
            reasoningEffort = ""
        }
        let compatible = catalog.accounts(for: harness)
        if let accountID, compatible.contains(where: { $0.id == accountID }) { return }
        if case .account(let account) = catalog.defaultAccount(for: harness) { accountID = account.id } else { accountID = nil }
    }

    /// Keeps the effort when the new model accepts it, otherwise takes the harness default or the first one.
    public mutating func adopt(model: String, catalog: SandboxLaunchCatalog) {
        self.model = model
        guard let options = catalog.harness(harness) else { return }
        let efforts = options.efforts(for: model)
        if efforts.contains(reasoningEffort) { return }
        reasoningEffort = efforts.contains(options.defaultReasoningEffort) ? options.defaultReasoningEffort : (efforts.first ?? "")
    }

    /// Clears a repository the new golden does not record, switches away from a harness the
    /// golden's provider does not support, and clamps the TTL to its provider.
    public mutating func adopt(goldenID: String, catalog: SandboxLaunchCatalog) {
        self.goldenID = goldenID
        guard let golden = catalog.golden(goldenID) else { return }
        let supported = catalog.harnesses(for: golden)
        if !supported.contains(where: { $0.id == harness }) {
            adopt(harness: supported.first?.id ?? "", catalog: catalog)
        }
        if let repository, !catalog.repositories(of: golden).contains(repository) { self.repository = nil }
        if let limit = catalog.maxTTLSeconds(for: golden), ttlSeconds > limit {
            ttlSeconds = catalog.ttlChoices(for: golden).last { $0 <= limit } ?? limit
        }
    }

    public func request(
        catalog: SandboxLaunchCatalog,
        now: Date = Date(),
        idempotencyKey: String = UUID().uuidString.lowercased()
    ) -> Result<SandboxLaunchRequest, SandboxLaunchDraftProblem> {
        guard let golden = catalog.golden(goldenID) else { return .failure(.missingGolden) }
        guard golden.isReady else { return .failure(.goldenNotReady) }
        guard let options = catalog.harnesses(for: golden).first(where: { $0.id == harness }) else {
            return .failure(catalog.harness(harness) == nil ? .missingHarness : .unsupportedHarness)
        }
        let model = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !model.isEmpty else { return .failure(.missingModel) }
        let effort = reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !effort.isEmpty, options.efforts(for: model).contains(effort) else { return .failure(.unsupportedEffort) }
        let compatible = catalog.accounts(for: harness)
        var credentialID: String?
        if let accountID {
            guard let account = compatible.first(where: { $0.id == accountID }) else { return .failure(.missingAccount) }
            if let problem = account.problem(now: now) { return .failure(.unusableAccount(account.name, problem)) }
            credentialID = account.id
        } else if catalog.defaultAccount(for: harness) == .ambiguous {
            return .failure(.missingAccount)
        }
        if let repository, !catalog.repositories(of: golden).contains(repository) { return .failure(.unknownRepository) }
        if let size, !catalog.machineSizes.contains(size) { return .failure(.unknownSize) }
        let limit = catalog.maxTTLSeconds(for: golden) ?? Int.max
        guard ttlSeconds >= 1, ttlSeconds <= limit else { return .failure(.ttlOutOfRange) }
        let prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return .failure(.missingPrompt) }
        return .success(SandboxLaunchRequest(
            org: catalog.orgID,
            golden: golden.name,
            provider: golden.provider,
            harness: options.id,
            model: model,
            reasoningEffort: effort,
            credentialId: credentialID,
            repo: repository,
            size: size,
            prompt: prompt,
            ttlSeconds: ttlSeconds == catalog.defaultTTLSeconds ? nil : ttlSeconds,
            idempotencyKey: idempotencyKey
        ))
    }
}

public enum SandboxLaunchDraftProblem: Error, Sendable, Equatable {
    case missingGolden
    case goldenNotReady
    case missingHarness
    case unsupportedHarness
    case missingModel
    case unsupportedEffort
    case missingAccount
    case unusableAccount(String, String)
    case unknownRepository
    case unknownSize
    case ttlOutOfRange
    case missingPrompt

    public var message: String {
        switch self {
        case .missingGolden: "Choose a golden."
        case .goldenNotReady: "This golden has no saved snapshot yet."
        case .missingHarness: "Choose an agent."
        case .unsupportedHarness: "This agent isn't available on the selected golden's provider."
        case .missingModel: "Choose a model."
        case .unsupportedEffort: "Choose a reasoning effort this model accepts."
        case .missingAccount: "Choose the model account this agent runs on."
        case .unusableAccount(let name, let problem): "\(name) can't run now (\(problem)). Choose another account."
        case .unknownRepository: "Choose a repository recorded in the golden."
        case .unknownSize: "Choose a machine size Armada offers."
        case .ttlOutOfRange: "Choose a lifetime this golden's provider accepts."
        case .missingPrompt: "Write the first prompt."
        }
    }
}

/// The body of `POST /api/v1/sandbox/launch`, the route `armada new` and the
/// dashboard use. Omitted optionals leave the server's defaults (golden size policy, account
/// resolution, default TTL). The request carries an idempotency key and sizing policy version and is sent once.
public struct SandboxLaunchRequest: Encodable, Sendable, Equatable {
    public static let route = "sandbox/launch"
    /// Launching forks, initializes and starts the agent in one request; the CLI allows ten minutes.
    static let timeout: TimeInterval = 600

    public let org: String
    public let golden: String
    public let provider: String
    public let harness: String
    public let model: String
    public let reasoningEffort: String
    public let credentialId: String?
    public let repo: String?
    public let size: String?
    public let prompt: String
    public let ttlSeconds: Int?
    public let idempotencyKey: String
    public let sizePolicyVersion = 1

    enum CodingKeys: String, CodingKey {
        case org, golden, provider, harness, model, reasoningEffort, credentialId, repo, size, prompt, ttlSeconds, idempotencyKey, sizePolicyVersion
    }
}

/// The synchronous launch envelope or the acknowledgement from an admitted launch job.
public enum SandboxLaunchReceipt: Decodable, Sendable, Equatable {
    case allocated(Allocation)
    case admitted(Admission)

    public struct Admission: Decodable, Sendable, Equatable {
        public enum Status: String, Decodable, Sendable {
            case starting, ready, running, stopping, stopped, failed, deleted
        }

        public let id: String
        public let status: Status
    }

    public struct Sandbox: Decodable, Sendable, Equatable {
        public let id: String
        public let provider: String
        public let providerSandboxId: String?
        public let orgId: String
        public let ownerId: String
        public let harness: String
        public let status: String
        public let model: String?
        public let reasoningEffort: String?
        public let createdAt: String
        public let expiresAt: String?
        public let effectiveTtlSeconds: Int?
    }

    public struct Allocation: Decodable, Sendable, Equatable {
        public let sandbox: Sandbox
        public let promptId: String?
        public let conversationId: String?
        public let ttlSeconds: Int?
    }

    public var sandboxID: String {
        switch self {
        case .allocated(let allocation): allocation.sandbox.id
        case .admitted(let admission): admission.id
        }
    }

    private struct Key: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    public init(from decoder: any Decoder) throws {
        let envelope = try decoder.container(keyedBy: Key.self)
        let sandbox = Key(stringValue: "sandbox")
        if envelope.allKeys.map(\.stringValue) == ["sandbox"] {
            let fields = try envelope.nestedContainer(keyedBy: Key.self, forKey: sandbox)
            if Set(fields.allKeys.map(\.stringValue)) == ["id", "status"] {
                self = .admitted(try envelope.decode(Admission.self, forKey: sandbox))
                return
            }
        }
        self = .allocated(try Allocation(from: decoder))
    }
}

// MARK: Refusals

/// Why a launch did not give a sandbox, for the person. Nothing here renders a raw body: a code
/// selects local text, and a structured pre-start server reason is shown on one bounded line; post-start command output is hidden.
public struct SandboxLaunchRefusal: Sendable, Equatable {
    public let code: String
    public let title: String
    public let hint: String
    /// The server's own short pre-start reason, never post-start command output.
    public let detail: String?
}

/// How a failed launch must be presented. Each launch carries an idempotency key and is sent once;
/// an outcome that is not a definite answer is `unconfirmed`, never retried automatically by the client.
public enum SandboxLaunchFailure: Error, Sendable, Equatable {
    case signedOut
    /// Refused before anything was started. Every field is kept; fix and launch again.
    case refused(SandboxLaunchRefusal)
    /// A sandbox was created but did not get to run the prompt; it may be listed as failed.
    case failedAfterStart(SandboxLaunchRefusal)
    /// The answer was lost: a sandbox may exist. Check the list before launching again.
    case unconfirmed
    case unconfirmedWithReason(String)
    /// Nothing left the device (offline, the session could not be refreshed). Safe to launch again.
    case notSent
    case notSentWithReason(String)

    /// 4xx codes the server answers before any machine is allocated (`LaunchError`, `VaultError`,
    /// `GoldenError` and a provider's `invalid_request`/`forbidden` refusal of the fork).
    static let preStartCodes: Set<String> = [
        "invalid", "invalid_request", "invalid_config", "no_credentials", "missing_credential", "forbidden",
        "not_found", "conflict", "credential_refused", "credential_binding_required",
    ]
    /// Non-allocating 5xx refusals before a machine is started. Other 5xx codes, including
    /// provider/dependency outages and outcome_unknown, do not prove that no machine was allocated.
    static let nonAllocatingServerCodes: Set<String> = [
        "unauthorized", "payment_required", "provider_not_configured", "provider_routing_unavailable", "not_found",
    ]
    /// Launch steps that fail after the fork (`LaunchError` in `@armada/core`).
    static let postStartCodes: Set<String> = ["start_failed", "init_failed", "prompt_failed"]
    /// Codes that mean the outcome is not known. The server answers them as 5xx; they stay
    /// unconfirmed even on a 4xx, so a refusal is never inferred from them.
    static let uncertainCodes: Set<String> = [
        "outcome_unknown", "provider_unavailable", "dependency_unavailable", "unavailable", "internal", "unknown",
    ]

    /// Classifies a non-2xx answer of the launch route (401 is handled as sign-out before this).
    public static func classify(status: Int, body: Data) -> SandboxLaunchFailure {
        struct Envelope: Decodable {
            struct Detail: Decodable { let code: String; let message: String? }
            let error: Detail
        }
        let envelope = try? JSONDecoder().decode(Envelope.self, from: body)
        let code = envelope?.error.code ?? ""
        let explanation = (ArmadaServerFailure.explaining(.unavailable, body: body) as? ArmadaServerFailure)?.explanation
        let uncertain: SandboxLaunchFailure = explanation.map { .unconfirmedWithReason($0) } ?? .unconfirmed
        if postStartCodes.contains(code) { return .failedAfterStart(refusal(code: code, message: nil)) }
        // A 5xx is a definite refusal only when its code says nothing was allocated.
        if status >= 500 {
            guard nonAllocatingServerCodes.contains(code) else { return uncertain }
            return .refused(refusal(code: code, message: envelope?.error.message))
        }
        guard (400..<500).contains(status), !uncertainCodes.contains(code) else { return uncertain }
        // A 4xx without an envelope (a missing route) or with a pre-start code allocated nothing.
        if code.isEmpty || preStartCodes.contains(code) || status == 403 || status == 404 {
            return .refused(refusal(code: code, message: envelope?.error.message))
        }
        // A code this build does not know, with the server's own reason, is still a definite answer:
        // the server reports an unknown outcome as a 5xx. Without a reason there is nothing to show.
        guard envelope?.error.message.flatMap(oneLine) != nil else { return uncertain }
        return .refused(refusal(code: code, message: envelope?.error.message))
    }

    /// Classifies a thrown error of the launch call.
    public static func classify(_ error: any Error) -> SandboxLaunchFailure {
        if let failure = error as? SandboxLaunchFailure { return failure }
        if let server = error as? ArmadaServerFailure { return .unconfirmedWithReason(server.explanation) }
        if case .signedOut? = error as? ArmadaError { return .signedOut }
        return .unconfirmed
    }

    /// Transport errors raised before a connection was made: the launch was never sent.
    static func neverConnected(_ error: URLError) -> Bool {
        [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed].contains(error.code)
    }

    static func refusal(code: String, message: String?) -> SandboxLaunchRefusal {
        let help: (String, String)
        // A code without local text shows the server's own reason, bounded to one line.
        let showsMessage = !postStartCodes.contains(code)
        switch code {
        case "payment_required":
            help = ("Provider plan limit reached", "The provider refused to start a machine for this plan or billing state. An admin can check the provider account, then launch again.")
        case "credential_refused":
            help = ("Account credential refused", "The selected account credential was refused, revoked or expired. Its owner can replace or reconnect the account from the dashboard or the CLI, then launch again.")
        case "credential_binding_required":
            help = ("Model account required", "This launch requires a bound model account. Add or select one from the dashboard or the CLI, then launch again.")
        case "unauthorized":
            help = ("Provider credential refused", "The provider did not accept the organization's provider credential. An admin reconnects it from the dashboard or the CLI.")
        case "no_credentials", "missing_credential":
            help = ("No model account for this agent", "Neither you nor the organization has an account this agent can use. Add one from the dashboard or the CLI, then launch again.")
        case "provider_not_configured":
            help = ("Provider not connected", "This golden's provider isn't connected for the organization. An admin connects it from the dashboard or the CLI.")
        case "provider_routing_unavailable":
            help = ("Provider setup incomplete", "The server's provider configuration is incomplete. Ask an administrator to finish provider setup, then launch again.")
        case "forbidden":
            help = ("Not allowed", "Armada did not let you launch from this golden.")
        case "not_found":
            help = ("Not found", "Something this launch names no longer exists or is no longer visible to you, such as the golden or the model account. Pull to refresh the options.")
        case "conflict":
            help = ("Can't launch yet", "Armada can't launch this combination in its current state.")
        case "start_failed":
            help = ("The sandbox didn't start", "The provider could not start the machine. If a failed sandbox appears in the list, its details say why.")
        case "init_failed":
            help = ("Golden setup failed", "Updating a repository or running an init command of the golden failed. The golden's owner can fix it; the failed sandbox may appear in the list.")
        case "prompt_failed":
            help = ("The agent didn't start", "The sandbox is set up but the first prompt was refused. Open it from the list to send the prompt again.")
        default:
            help = ("Armada refused this launch", "Check the choices and launch again.")
        }
        let cleaned = showsMessage ? message.flatMap(oneLine) : nil
        let detail = cleaned == code ? nil : cleaned
        return SandboxLaunchRefusal(code: code, title: help.0, hint: help.1, detail: detail)
    }

    /// One trimmed line without control characters, at most 300 characters.
    static func oneLine(_ text: String) -> String? {
        let cleaned = String(String.UnicodeScalarView(text.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : $0 }))
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !cleaned.isEmpty else { return nil }
        return cleaned.count > 300 ? String(cleaned.prefix(299)) + "…" : cleaned
    }
}

// MARK: Client

extension ArmadaClient {
    /// The server's launch catalogs (`launch/options`).
    public func launchOptions() async throws -> LaunchOptions {
        try await post("launch/options", Empty())
    }

    /// Goldens of the selected organization the person can see (`golden/list`).
    public func launchGoldens() async throws -> [LaunchGolden] {
        struct Read: Encodable, Sendable { let org: String }
        let org = try launchOrganization()
        let list: LaunchGoldenList = try await post("golden/list", Read(org: org))
        return list.goldens.filter { $0.orgId == org }
    }

    /// Named model accounts of the person and the selected organization (`creds/list`).
    public func launchAccounts() async throws -> [LaunchAccount] {
        struct Read: Encodable, Sendable { let org: String }
        let org = try launchOrganization()
        let list: LaunchCredentialList = try await post("creds/list", Read(org: org))
        return list.accounts(orgID: org)
    }

    /// Everything the New sandbox form offers, read together.
    public func launchCatalog() async throws -> SandboxLaunchCatalog {
        let org = try launchOrganization()
        async let options = launchOptions()
        async let goldens = launchGoldens()
        async let accounts = launchAccounts()
        return SandboxLaunchCatalog(orgID: org, options: try await options, goldens: try await goldens, accounts: try await accounts)
    }

    /// Launches once with an idempotency key; never retried automatically by this client.
    /// A failure before the request leaves the device (no organization, no fresh session, offline)
    /// is `notSent`, `refused` or `signedOut`, never `unconfirmed`.
    public func launchSandbox(_ request: SandboxLaunchRequest) async throws(SandboxLaunchFailure) -> SandboxLaunchReceipt {
        do {
            guard try launchOrganization() == request.org else { throw ArmadaError.forbidden }
        } catch {
            if case .signedOut? = error as? ArmadaError { throw .signedOut }
            throw .refused(SandboxLaunchFailure.refusal(code: "forbidden", message: nil))
        }
        do {
            // Refresh the session first so a refresh failure is known not to have sent the launch.
            _ = try await authority()
        } catch {
            if case .signedOut? = error as? ArmadaError { throw .signedOut }
            if let server = error as? ArmadaServerFailure { throw .notSentWithReason(server.explanation) }
            throw .notSent
        }
        let receipt: SandboxLaunchReceipt
        do {
            receipt = try await post(SandboxLaunchRequest.route, request)
        } catch {
            throw SandboxLaunchFailure.classify(error)
        }
        guard UUID(uuidString: receipt.sandboxID) != nil else { throw .unconfirmed }
        switch receipt {
        case .allocated(let allocation):
            guard allocation.sandbox.orgId == request.org, allocation.sandbox.provider == request.provider else {
                throw .unconfirmed
            }
        case .admitted(let admission):
            // Match the UUID versions, variant and special values in the launch admission receipt schema.
            let uuid = #/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff/#
            guard ["boat", "modal", "docker"].contains(request.provider), admission.id.wholeMatch(of: uuid) != nil else {
                throw .unconfirmed
            }
        }
        return receipt
    }

    private func launchOrganization() throws -> String {
        guard isSignedIn else { throw ArmadaError.signedOut }
        guard let selectedOrgID else { throw ArmadaError.forbidden }
        return selectedOrgID
    }
}
