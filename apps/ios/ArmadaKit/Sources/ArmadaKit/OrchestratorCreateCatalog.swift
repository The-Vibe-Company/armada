import Foundation

/// A golden of the selected organization, as `POST /api/v1/golden/list` reports it (`armada golden list`).
/// Only what creating an orchestrator needs is decoded.
public struct GoldenSummary: Decodable, Sendable, Equatable, Identifiable {
    public struct Config: Decodable, Sendable, Equatable {
        public struct Repo: Decodable, Sendable, Equatable { public let dir: String }
        public let repos: [Repo]
    }
    public let id: String
    public let name: String
    public let orgId: String
    public let provider: ArmadaProvider
    /// Null until the golden's snapshot is saved; an orchestrator starts only from a saved one.
    public let providerSnapshotId: String?
    public let config: Config
    public var isReady: Bool { providerSnapshotId?.isEmpty == false }
    public var repositories: [String] { config.repos.map(\.dir) }
}

/// A named model account the person may use in the selected organization, theirs or the org's,
/// from `POST /api/v1/creds/list`. Ids, names and kinds only: never a credential value.
public struct ModelAccount: Sendable, Equatable, Identifiable {
    public enum Scope: String, Sendable { case user, org }
    public let id: String
    public let name: String
    /// The credential kind (`claude_oauth`, `openai`, …). Which harness it runs comes from the
    /// server's `HarnessCatalog.accountKinds`, never from a table in the app.
    public let kind: String
    public let scope: Scope
    public let isDefault: Bool
    public init(id: String, name: String, kind: String, scope: Scope, isDefault: Bool) {
        self.id = id; self.name = name; self.kind = kind; self.scope = scope; self.isDefault = isDefault
    }
}

struct CredentialListing: Decodable, Sendable {
    struct Row: Decodable, Sendable {
        let id: String?
        let name: String?
        let kind: String
        let status: String?
        let expiresAt: String?
        let isDefault: Bool?
    }
    struct Org: Decodable, Sendable { let id: String; let credentials: [Row] }
    let user: [Row]
    let orgs: [Org]

    /// Usable now: named (has an id), active, not expired at `now`.
    func accounts(orgId: String, now: Date) -> [ModelAccount] {
        func read(_ rows: [Row], _ scope: ModelAccount.Scope) -> [ModelAccount] {
            rows.compactMap { row in
                guard let id = row.id, !id.isEmpty, row.status == nil || row.status == "active" else { return nil }
                if let expiresAt = row.expiresAt, let expiry = Self.date(expiresAt), expiry <= now { return nil }
                let name = row.name?.trimmingCharacters(in: .whitespacesAndNewlines)
                return ModelAccount(id: id, name: name?.isEmpty == false ? name! : row.kind, kind: row.kind,
                                    scope: scope, isDefault: row.isDefault == true)
            }
        }
        return read(user, .user) + read(orgs.first { $0.id == orgId }?.credentials ?? [], .org)
    }

    private static func date(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

extension ArmadaClient {
    /// The selected organization's goldens: `POST /api/v1/golden/list` with `org`, the CLI's route.
    public func goldens() async throws -> [GoldenSummary] {
        struct Body: Encodable, Sendable { let org: String }
        struct Listing: Decodable, Sendable { let goldens: [GoldenSummary] }
        guard let org = selectedOrgID else { throw isSignedIn ? ArmadaError.forbidden : ArmadaError.signedOut }
        let listing: Listing = try await post("golden/list", Body(org: org))
        return listing.goldens.filter { $0.orgId == org }
    }

    /// Named model accounts usable in the selected organization: `POST /api/v1/creds/list` with `org`.
    public func modelAccounts(now: Date = Date()) async throws -> [ModelAccount] {
        struct Body: Encodable, Sendable { let org: String }
        guard let org = selectedOrgID else { throw isSignedIn ? ArmadaError.forbidden : ArmadaError.signedOut }
        let listing: CredentialListing = try await post("creds/list", Body(org: org))
        return listing.accounts(orgId: org, now: now)
    }
}

/// Everything the create form may offer, filtered by what the server reports: only goldens with a
/// saved snapshot, only provider × harness pairs the capabilities mark enabled (a disabled pair
/// keeps its reason), the server's model suggestions and the accounts whose kind runs the harness.
public struct OrchestratorCreateCatalog: Sendable, Equatable {
    /// One harness for a golden's provider, offered or explained.
    public struct PairOffer: Sendable, Equatable, Identifiable {
        public let harness: ArmadaHarness
        public let enabled: Bool
        /// A plain sentence for a disabled pair; nil when enabled.
        public let explanation: String?
        public var id: String { harness.rawValue }
    }

    public enum Problem: Error, Sendable, Equatable {
        case missingName, nameTooLong, missingGolden, goldenNotReady, pairDisabled(String), missingModel
        case unsupportedEffort, missingAccount, unknownRepository, idleOutOfRange

        public var message: String {
            switch self {
            case .missingName: "Name the orchestrator."
            case .nameTooLong: "Keep the name to 120 characters."
            case .missingGolden: "Choose a golden."
            case .goldenNotReady: "This golden has no saved snapshot yet."
            case .pairDisabled(let reason): reason
            case .missingModel: "Choose a model."
            case .unsupportedEffort: "That reasoning effort is not available for this model."
            case .missingAccount: "Choose a model account for this agent."
            case .unknownRepository: "Choose a repository recorded in the golden."
            case .idleOutOfRange: "Choose an idle stop between 15 minutes and 24 hours."
            }
        }
    }

    /// What the person chose. Empty strings and nil leave the server's defaults.
    public struct Draft: Sendable, Equatable {
        public var name: String
        public var goldenId: String?
        public var harness: ArmadaHarness?
        public var model: String
        public var reasoningEffort: String
        public var accountId: String?
        public var repository: String?
        /// nil: the server's default inactivity period applies and is not sent.
        public var idleSeconds: Int?
        public init(name: String = "", goldenId: String? = nil, harness: ArmadaHarness? = nil, model: String = "",
                    reasoningEffort: String = "", accountId: String? = nil, repository: String? = nil, idleSeconds: Int? = nil) {
            self.name = name; self.goldenId = goldenId; self.harness = harness; self.model = model
            self.reasoningEffort = reasoningEffort; self.accountId = accountId; self.repository = repository
            self.idleSeconds = idleSeconds
        }
    }

    /// `ORCHESTRATOR_DEFAULTS` bounds; the server validates again.
    public static let idleRange = 900...86_400

    public let goldens: [GoldenSummary]
    public let accounts: [ModelAccount]
    let pairs: [OrchestratorCapabilities.Pair]
    let harnesses: [OrchestratorCapabilities.HarnessCatalog]

    public init(capabilities: OrchestratorCapabilities, goldens: [GoldenSummary], accounts: [ModelAccount]) {
        self.goldens = goldens.sorted { ($0.isReady ? 0 : 1, $0.name) < ($1.isReady ? 0 : 1, $1.name) }
        self.accounts = accounts
        pairs = capabilities.pairs ?? []
        harnesses = capabilities.harnesses ?? []
    }

    /// Whether anything at all can be created: some enabled pair whose provider has a ready golden.
    public var canCreate: Bool {
        goldens.contains { golden in golden.isReady && offers(for: golden).contains(where: \.enabled) }
    }

    /// The harnesses the server reports for this golden's provider, enabled ones first, in server order.
    public func offers(for golden: GoldenSummary) -> [PairOffer] {
        let forProvider = pairs.filter { $0.provider == golden.provider }
        let offers = forProvider.map { pair in
            PairOffer(harness: pair.harness, enabled: pair.enabled && catalog(for: pair.harness) != nil,
                      explanation: pair.enabled
                          ? (catalog(for: pair.harness) == nil ? OrchestratorExplanation.text(for: "harness_catalog_missing") : nil)
                          : OrchestratorExplanation.text(for: pair.reason ?? "server_setting_off"))
        }
        return offers.filter(\.enabled) + offers.filter { !$0.enabled }
    }

    public func catalog(for harness: ArmadaHarness) -> OrchestratorCapabilities.HarnessCatalog? {
        harnesses.first { $0.harness == harness }
    }

    /// Accounts whose kind runs `harness`, defaults first.
    public func accounts(for harness: ArmadaHarness) -> [ModelAccount] {
        guard let kinds = catalog(for: harness)?.accountKinds else { return [] }
        let matching = accounts.filter { kinds.contains($0.kind) }
        return matching.filter(\.isDefault) + matching.filter { !$0.isDefault }
    }

    /// A first draft: the first ready golden that has an enabled pair, its first enabled harness and
    /// that harness's defaults.
    public func initialDraft() -> Draft {
        var draft = Draft()
        let golden = goldens.first { $0.isReady && offers(for: $0).contains(where: \.enabled) }
            ?? goldens.first(where: \.isReady)
        draft.goldenId = golden?.id
        if let golden { adopt(golden: golden, into: &draft) }
        return draft
    }

    /// After a golden change: keep the harness when still enabled for its provider, else the first one.
    public func adopt(golden: GoldenSummary, into draft: inout Draft) {
        draft.goldenId = golden.id
        if let repository = draft.repository, !golden.repositories.contains(repository) { draft.repository = nil }
        let enabled = offers(for: golden).filter(\.enabled).map(\.harness)
        if let harness = draft.harness, enabled.contains(harness) { return }
        if let first = enabled.first { adopt(harness: first, into: &draft) } else { draft.harness = nil }
    }

    /// After a harness change: its default model and effort and its first (default) account.
    public func adopt(harness: ArmadaHarness, into draft: inout Draft) {
        draft.harness = harness
        let catalog = catalog(for: harness)
        draft.model = catalog?.defaultModel ?? ""
        draft.reasoningEffort = catalog?.defaultReasoningEffort ?? ""
        let usable = accounts(for: harness)
        if let id = draft.accountId, usable.contains(where: { $0.id == id }) { return }
        draft.accountId = usable.first?.id
    }

    /// The exact `OrchestratorCreate` to save, or the first problem. Mirrors the server's checks so
    /// the person learns early; the server still decides.
    public func request(orgId: String, draft: Draft) -> Result<OrchestratorCreate, Problem> {
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return .failure(.missingName) }
        guard name.count <= 120 else { return .failure(.nameTooLong) }
        guard let goldenId = draft.goldenId, let golden = goldens.first(where: { $0.id == goldenId }) else {
            return .failure(.missingGolden)
        }
        guard golden.isReady else { return .failure(.goldenNotReady) }
        guard let harness = draft.harness, let offer = offers(for: golden).first(where: { $0.harness == harness }) else {
            return .failure(.pairDisabled(OrchestratorExplanation.text(for: "server_setting_off")))
        }
        guard offer.enabled, let catalog = catalog(for: harness) else {
            return .failure(.pairDisabled(offer.explanation ?? OrchestratorExplanation.text(for: "server_setting_off")))
        }
        let model = draft.model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !model.isEmpty else { return .failure(.missingModel) }
        let effort = draft.reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)
        if !effort.isEmpty, !catalog.efforts(for: model).contains(effort) { return .failure(.unsupportedEffort) }
        guard let accountId = draft.accountId, accounts(for: harness).contains(where: { $0.id == accountId }) else {
            return .failure(.missingAccount)
        }
        if let repository = draft.repository, !golden.repositories.contains(repository) {
            return .failure(.unknownRepository)
        }
        if let idle = draft.idleSeconds, !Self.idleRange.contains(idle) { return .failure(.idleOutOfRange) }
        return .success(OrchestratorCreate(
            orgId: orgId, name: name, goldenId: golden.id, provider: golden.provider, harness: harness,
            model: model, modelAccountId: accountId, repo: draft.repository,
            reasoningEffort: effort.isEmpty ? nil : effort, idleSeconds: draft.idleSeconds
        ))
    }
}
