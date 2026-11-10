import Foundation

// The goldens and model accounts come from the same reads as the New sandbox form (#750):
// `ArmadaClient.launchGoldens()` (`golden/list`) and `launchAccounts()` (`creds/list`), decoded as
// `LaunchGolden` and `LaunchAccount`. Only the capabilities and the per-harness catalog are
// orchestrator-specific.

/// Everything the create form may offer, filtered by what the server reports: only goldens with a
/// saved snapshot, only provider × harness pairs the capabilities mark enabled (a disabled pair
/// keeps its reason, an enabled one says how far the server guarantees a resume), the server's model
/// suggestions and the usable accounts whose kind runs the harness, the person's before the org's.
public struct OrchestratorCreateCatalog: Sendable, Equatable {
    /// One harness for a golden's provider, offered or explained.
    public struct PairOffer: Sendable, Equatable, Identifiable {
        public let harness: ArmadaHarness
        public let enabled: Bool
        /// A plain sentence for a disabled pair; nil when enabled.
        public let explanation: String?
        /// The server's continuity level for the pair (`native`, `best_effort`, or a newer one).
        public let continuity: String?
        public var id: String { harness.rawValue }

        /// The continuity level in plain words, or nil when the server did not report one.
        public var continuityLabel: String? {
            switch continuity {
            case nil: nil
            case "native": "Resume guaranteed"
            case "best_effort": "Resume not guaranteed"
            case let other?: "Resume: \(other.replacingOccurrences(of: "_", with: " "))"
            }
        }
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

    /// The organization's goldens, ready ones first, then by name.
    public let goldens: [LaunchGolden]
    /// Accounts usable now (active, not expired); revoked or expired ones are never offered.
    public let accounts: [LaunchAccount]
    let pairs: [OrchestratorCapabilities.Pair]
    let harnesses: [OrchestratorCapabilities.HarnessCatalog]

    public init(capabilities: OrchestratorCapabilities, goldens: [LaunchGolden], accounts: [LaunchAccount], now: Date = Date()) {
        self.goldens = goldens.sorted { lhs, rhs in
            if lhs.isReady != rhs.isReady { return lhs.isReady }
            let order = lhs.name.localizedStandardCompare(rhs.name)
            return order == .orderedSame ? lhs.provider < rhs.provider : order == .orderedAscending
        }
        self.accounts = accounts.filter { $0.problem(now: now) == nil }
        pairs = capabilities.pairs ?? []
        harnesses = capabilities.harnesses ?? []
    }

    public func golden(_ id: String?) -> LaunchGolden? { id.flatMap { id in goldens.first { $0.id == id } } }

    /// Repository directories recorded in the golden.
    public func repositories(of golden: LaunchGolden) -> [String] { golden.config.repos.map(\.dir) }

    /// Whether anything at all can be created: some enabled pair whose provider has a ready golden.
    public var canCreate: Bool {
        goldens.contains { golden in golden.isReady && offers(for: golden).contains(where: \.enabled) }
    }

    /// The harnesses the server reports for this golden's provider, enabled ones first, in server order.
    public func offers(for golden: LaunchGolden) -> [PairOffer] {
        let forProvider = pairs.filter { $0.provider.rawValue == golden.provider }
        let offers = forProvider.map { pair in
            let listed = catalog(for: pair.harness) != nil
            return PairOffer(
                harness: pair.harness,
                enabled: pair.enabled && listed,
                explanation: pair.enabled
                    ? (listed ? nil : OrchestratorExplanation.text(for: "harness_catalog_missing"))
                    : OrchestratorExplanation.text(for: pair.reason ?? "server_setting_off"),
                continuity: pair.continuity
            )
        }
        return offers.filter(\.enabled) + offers.filter { !$0.enabled }
    }

    public func catalog(for harness: ArmadaHarness) -> OrchestratorCapabilities.HarnessCatalog? {
        harnesses.first { $0.harness == harness }
    }

    /// Usable accounts whose kind runs `harness`, the person's before the org's: the order the
    /// server resolves them (#603).
    public func accounts(for harness: ArmadaHarness) -> [LaunchAccount] {
        guard let kinds = catalog(for: harness)?.accountKinds else { return [] }
        let matching = accounts.filter { kinds.contains($0.kind) }
        return matching.filter { $0.scope == .user } + matching.filter { $0.scope == .org }
    }

    /// The account preselected for `harness`, as the server would resolve it: the personal default,
    /// the only personal account, the org default, the only org account. Several with no default is
    /// nil: the person chooses, no billing account is picked for them.
    public func defaultAccount(for harness: ArmadaHarness) -> LaunchAccount? {
        let compatible = accounts(for: harness)
        for scope in [LaunchAccount.Scope.user, .org] {
            let rows = compatible.filter { $0.scope == scope }
            if let pick = rows.first(where: \.isDefault) ?? (rows.count == 1 ? rows.first : nil) { return pick }
            if rows.count > 1 { return nil }
        }
        return nil
    }

    /// The account picker is shown only when there is a real choice; a single account is shown as text.
    public func offersAccountChoice(for harness: ArmadaHarness) -> Bool { accounts(for: harness).count > 1 }

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
    public func adopt(golden: LaunchGolden, into draft: inout Draft) {
        draft.goldenId = golden.id
        if let repository = draft.repository, !repositories(of: golden).contains(repository) { draft.repository = nil }
        let enabled = offers(for: golden).filter(\.enabled).map(\.harness)
        if let harness = draft.harness, enabled.contains(harness) { return }
        if let first = enabled.first { adopt(harness: first, into: &draft) } else { draft.harness = nil }
    }

    /// After a harness change: its default model and effort, and its default account unless the
    /// chosen one still runs it.
    public func adopt(harness: ArmadaHarness, into draft: inout Draft) {
        draft.harness = harness
        let catalog = catalog(for: harness)
        draft.model = catalog?.defaultModel ?? ""
        draft.reasoningEffort = catalog?.defaultReasoningEffort ?? ""
        if let id = draft.accountId, accounts(for: harness).contains(where: { $0.id == id }) { return }
        draft.accountId = defaultAccount(for: harness)?.id
    }

    /// After a model change: keep the effort when the model accepts it, else the harness default or
    /// the model's first effort.
    public func adopt(model: String, into draft: inout Draft) {
        draft.model = model
        guard let harness = draft.harness, let catalog = catalog(for: harness) else { return }
        let efforts = catalog.efforts(for: model)
        if efforts.contains(draft.reasoningEffort) { return }
        draft.reasoningEffort = efforts.contains(catalog.defaultReasoningEffort) ? catalog.defaultReasoningEffort : (efforts.first ?? "")
    }

    /// The exact `OrchestratorCreate` to save, or the first problem. Mirrors the server's checks so
    /// the person learns early; the server still decides.
    public func request(orgId: String, draft: Draft) -> Result<OrchestratorCreate, Problem> {
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return .failure(.missingName) }
        guard name.count <= 120 else { return .failure(.nameTooLong) }
        guard let golden = golden(draft.goldenId), golden.orgId == orgId,
              let provider = ArmadaProvider(rawValue: golden.provider) else {
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
        if let repository = draft.repository, !repositories(of: golden).contains(repository) {
            return .failure(.unknownRepository)
        }
        if let idle = draft.idleSeconds, !Self.idleRange.contains(idle) { return .failure(.idleOutOfRange) }
        return .success(OrchestratorCreate(
            orgId: orgId, name: name, goldenId: golden.id, provider: provider, harness: harness,
            model: model, modelAccountId: accountId, repo: draft.repository,
            reasoningEffort: effort.isEmpty ? nil : effort, idleSeconds: draft.idleSeconds
        ))
    }
}
