import Foundation
import Testing
@testable import ArmadaKit

private final class LaunchMemoryStorage: SessionStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    func load() -> Data? { lock.withLock { data } }
    func save(_ value: Data) { lock.withLock { data = value } }
    func remove() { lock.withLock { data = nil } }
}
private actor LaunchTransport: ArmadaTransport {
    struct Reply: Sendable { let status: Int; let body: String }
    private var replies: [Reply]
    private let offlineWhenEmpty: Bool
    private(set) var requests: [URLRequest] = []
    init(_ replies: [Reply], offlineWhenEmpty: Bool = false) { self.replies = replies; self.offlineWhenEmpty = offlineWhenEmpty }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        guard !replies.isEmpty else { throw URLError(offlineWhenEmpty ? .notConnectedToInternet : .timedOut) }
        let next = replies.removeFirst()
        return (Data(next.body.utf8), HTTPURLResponse(url: request.url!, statusCode: next.status, httpVersion: nil, headerFields: nil)!)
    }
}

// Synthetic, non-authorizing values, never credentials from a running service.
private let login = #"{"accessToken":"fixture-access","refreshToken":"fixture-refresh","expiresAt":"2099-01-01T00:00:00Z"}"#
private let orgs = #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#
private let personalClaude = "0b6c1e9a-1111-4111-8111-111111111111"
private let orgClaude = "0b6c1e9a-2222-4222-8222-222222222222"
private let orgClaudeOther = "0b6c1e9a-3333-4333-8333-333333333333"
private let codexAccount = "0b6c1e9a-4444-4444-8444-444444444444"
private let newSandbox = "7d1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b"

/// The shape `launch/options` answers, with ids that are deliberately not the real catalog: the
/// app must offer what the server sends, not a list of its own.
private let optionsJSON = #"""
{"harnesses":[
 {"id":"claude","defaultModel":"model-a","defaultReasoningEffort":"medium","reasoningEfforts":["low","medium","high"],
  "models":[{"id":"model-a","label":"Model A","reasoningEfforts":["low","medium","high"]},{"id":"model-b","label":"Model B","reasoningEfforts":["low","high"]}],
  "credentialKinds":["claude_oauth","anthropic"]},
 {"id":"codex","defaultModel":"model-c","defaultReasoningEffort":"medium","reasoningEfforts":["low","medium"],
  "models":[{"id":"model-c","label":"Model C","reasoningEfforts":["low","medium"]}],
  "credentialKinds":["openai","codex_auth"]}],
 "machineSizes":["small","large"],
 "ttl":{"defaultSeconds":14400,"maxSeconds":{"boat":2592000,"modal":86400}}}
"""#

private func golden(id: String, name: String, provider: String = "boat", org: String = "org-a", snapshot: Bool = true, dirs: [String] = ["web"]) -> String {
    let repos = dirs.map { #"{"url":"https://github.com/acme/\#($0)","branch":"main","dir":"\#($0)"}"# }.joined(separator: ",")
    return #"{"id":"\#(id)","name":"\#(name)","provider":"\#(provider)","modal":null,"orgId":"\#(org)","visibility":"org","ownerId":"u1","providerSnapshotId":\#(snapshot ? #""snap""# : "null"),"providerSandboxId":null,"boatSnapshotId":null,"boatSandboxId":null,"repos":\#(dirs.count),"config":{"repos":[\#(repos)],"init":[]}}"#
}

private let goldensJSON = #"{"goldens":[\#(golden(id: "g-draft", name: "aaa", snapshot: false)),\#(golden(id: "g-web", name: "web", dirs: ["web", "api"])),\#(golden(id: "g-web-modal", name: "web", provider: "modal")),\#(golden(id: "g-other", name: "elsewhere", org: "org-b"))]}"#

private func credentials(user: String, org: String) -> String {
    #"{"user":[\#(user)],"orgs":[{"id":"org-a","name":"Team","role":"member","credentials":[{"kind":"boat","createdAt":null},\#(org)]}]}"#
}

private func account(_ id: String, kind: String, name: String, isDefault: Bool = false, status: String = "active", expiresAt: String? = nil) -> String {
    #"{"id":"\#(id)","name":"\#(name)","isDefault":\#(isDefault),"status":"\#(status)","expiresAt":\#(expiresAt.map { "\"\($0)\"" } ?? "null"),"kind":"\#(kind)","createdAt":null}"#
}

private func catalog(accounts: [LaunchAccount] = []) throws -> SandboxLaunchCatalog {
    let options = try JSONDecoder().decode(LaunchOptions.self, from: Data(optionsJSON.utf8))
    let goldens = try JSONDecoder().decode(LaunchGoldenList.self, from: Data(goldensJSON.utf8)).goldens
    return SandboxLaunchCatalog(orgID: "org-a", options: options, goldens: goldens, accounts: accounts)
}

private func make(_ id: String, kind: String = "claude_oauth", scope: LaunchAccount.Scope, isDefault: Bool = false, status: String = "active", expiresAt: Date? = nil) -> LaunchAccount {
    LaunchAccount(id: id, name: id.prefix(4) + "", kind: kind, scope: scope, isDefault: isDefault, status: status, expiresAt: expiresAt)
}

private func signedIn(_ replies: [LaunchTransport.Reply], offline: Bool = false) async throws -> (ArmadaClient, LaunchTransport) {
    let transport = LaunchTransport([.init(status: 200, body: login), .init(status: 200, body: orgs)] + replies, offlineWhenEmpty: offline)
    let client = try ArmadaClient(transport: transport, storage: LaunchMemoryStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    return (client, transport)
}

private func json(_ request: URLRequest) throws -> [String: Any] {
    try #require(JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any])
}

// MARK: Reading the options

@Test func catalogReadsTheServerRoutesForTheSelectedOrganizationAndKeepsOnlyNamedAccounts() async throws {
    let user = account(personalClaude, kind: "claude_oauth", name: "Personal", isDefault: true) + "," + account(codexAccount, kind: "codex_auth", name: "Removed", status: "deleted")
    let (client, transport) = try await signedIn([
        .init(status: 200, body: optionsJSON),
        .init(status: 200, body: goldensJSON),
        .init(status: 200, body: credentials(user: user, org: account(orgClaude, kind: "anthropic", name: "Team key")))
    ])
    // Read one after another so the scripted replies keep their order.
    let options = try await client.launchOptions()
    let goldens = try await client.launchGoldens()
    let accounts = try await client.launchAccounts()
    #expect(options.harnesses.map(\.id) == ["claude", "codex"])
    #expect(goldens.map(\.id) == ["g-draft", "g-web", "g-web-modal"])
    // The provider key row has no id and the removed account is not offered.
    #expect(accounts.map(\.id) == [personalClaude, orgClaude])
    #expect(accounts.map(\.scope) == [.user, .org])

    let requests = Array(await transport.requests.dropFirst(2))
    #expect(requests.map { $0.url!.path } == ["/api/v1/launch/options", "/api/v1/golden/list", "/api/v1/creds/list"])
    #expect(try json(requests[1]) as? [String: String] == ["org": "org-a"])
    #expect(try json(requests[2]) as? [String: String] == ["org": "org-a"])
}

@Test func optionsComeFromTheServerCatalogAndReadyGoldensComeFirst() throws {
    let catalog = try catalog()
    #expect(catalog.goldens.map(\.id) == ["g-web", "g-web-modal", "g-draft"])
    let web = try #require(catalog.golden("g-web"))
    #expect(catalog.needsProviderLabel(web))
    #expect(!catalog.needsProviderLabel(try #require(catalog.golden("g-draft"))))
    #expect(catalog.harness("claude")?.efforts(for: "model-b") == ["low", "high"])
    // A model outside the list takes the harness's efforts.
    #expect(catalog.harness("claude")?.efforts(for: "custom") == ["low", "medium", "high"])
    #expect(catalog.offersRepositoryChoice(for: web))
    #expect(!catalog.offersRepositoryChoice(for: try #require(catalog.golden("g-web-modal"))))
    #expect(catalog.machineSizes == ["small", "large"])
    // TTL presets stay within the golden's provider and always include the server default.
    #expect(catalog.ttlChoices(for: catalog.golden("g-web-modal")) == [3_600, 14_400, 28_800, 86_400])
    #expect(catalog.ttlChoices(for: web).last == 2_592_000)
}

@Test func theAccountPreselectedIsTheOneTheServerWouldResolve() throws {
    // Personal default wins over everything in the org.
    var accounts = [make(orgClaude, kind: "anthropic", scope: .org, isDefault: true), make(personalClaude, scope: .user, isDefault: true), make(codexAccount, kind: "openai", scope: .user)]
    #expect(try catalog(accounts: accounts).defaultAccount(for: "claude") == .account(accounts[1]))
    #expect(try catalog(accounts: accounts).accounts(for: "claude").map(\.id) == [personalClaude, orgClaude])
    #expect(try catalog(accounts: accounts).accounts(for: "codex").map(\.id) == [codexAccount])
    // Only org accounts: the org default.
    accounts = [make(orgClaude, scope: .org), make(orgClaudeOther, kind: "anthropic", scope: .org, isDefault: true)]
    #expect(try catalog(accounts: accounts).defaultAccount(for: "claude") == .account(accounts[1]))
    // Several personal accounts and no default: the person chooses.
    accounts = [make(personalClaude, scope: .user), make(orgClaudeOther, kind: "anthropic", scope: .user), make(orgClaude, scope: .org, isDefault: true)]
    let ambiguous = try catalog(accounts: accounts)
    #expect(ambiguous.defaultAccount(for: "claude") == .ambiguous)
    #expect(ambiguous.offersAccountChoice(for: "claude"))
    var draft = SandboxLaunchDraft(catalog: ambiguous)
    #expect(draft.accountID == nil)
    draft.prompt = "Fix CI"
    #expect(draft.request(catalog: ambiguous) == .failure(.missingAccount))
    #expect(try catalog().defaultAccount(for: "claude") == .none)
}

// MARK: Building the request

@Test func aDraftStartsFromServerDefaultsAndBuildsTheSizedLaunchBody() throws {
    let personal = make(personalClaude, scope: .user, isDefault: true)
    let catalog = try catalog(accounts: [personal, make(orgClaude, scope: .org)])
    var draft = SandboxLaunchDraft(catalog: catalog)
    #expect(draft.goldenID == "g-web")
    #expect(draft.harness == "claude")
    #expect(draft.model == "model-a")
    #expect(draft.reasoningEffort == "medium")
    #expect(draft.accountID == personalClaude)
    #expect(draft.ttlSeconds == 14_400)
    #expect(draft.request(catalog: catalog) == .failure(.missingPrompt))

    draft.prompt = "  Fix the flaky test\nand open a PR  "
    let request = try draft.request(catalog: catalog).get()
    let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
    #expect(body as NSDictionary == [
        "org": "org-a", "golden": "web", "provider": "boat", "harness": "claude", "model": "model-a",
        "reasoningEffort": "medium", "credentialId": personalClaude, "prompt": "Fix the flaky test\nand open a PR",
        "sizePolicyVersion": 1
    ] as NSDictionary)

    // Optional choices are sent only when made; a TTL other than the server default is sent.
    draft.repository = "api"
    draft.size = "large"
    draft.ttlSeconds = 3_600
    let chosen = try draft.request(catalog: catalog).get()
    #expect(chosen.repo == "api")
    #expect(chosen.size == "large")
    #expect(chosen.ttlSeconds == 3_600)
}

@Test func switchingHarnessModelOrGoldenKeepsTheDraftConsistent() throws {
    let codex = make(codexAccount, kind: "openai", scope: .user)
    let catalog = try catalog(accounts: [make(personalClaude, scope: .user), codex])
    var draft = SandboxLaunchDraft(catalog: catalog)
    draft.adopt(model: "model-b", catalog: catalog)
    // model-b has no "medium": the harness default is not offered, so the first effort is taken.
    #expect(draft.reasoningEffort == "low")
    draft.adopt(harness: "codex", catalog: catalog)
    #expect(draft.model == "model-c")
    #expect(draft.accountID == codexAccount)
    draft.repository = "api"
    draft.ttlSeconds = 7 * 86_400
    draft.adopt(goldenID: "g-web-modal", catalog: catalog)
    #expect(draft.repository == nil)
    #expect(draft.ttlSeconds == 86_400)
}

@Test func theDraftRefusesWhatTheServerWouldRefuse() throws {
    let expired = make(orgClaude, scope: .org, expiresAt: Date(timeIntervalSince1970: 0))
    let catalog = try catalog(accounts: [make(personalClaude, scope: .user, isDefault: true), expired])
    var draft = SandboxLaunchDraft(catalog: catalog)
    draft.prompt = "Go"
    var bad = draft; bad.goldenID = "g-draft"
    #expect(bad.request(catalog: catalog) == .failure(.goldenNotReady))
    bad = draft; bad.goldenID = "g-other"
    #expect(bad.request(catalog: catalog) == .failure(.missingGolden))
    bad = draft; bad.reasoningEffort = "max"
    #expect(bad.request(catalog: catalog) == .failure(.unsupportedEffort))
    bad = draft; bad.accountID = codexAccount
    #expect(bad.request(catalog: catalog) == .failure(.missingAccount))
    bad = draft; bad.accountID = orgClaude
    #expect(bad.request(catalog: catalog) == .failure(.unusableAccount(expired.name, "expired")))
    bad = draft; bad.repository = "infra"
    #expect(bad.request(catalog: catalog) == .failure(.unknownRepository))
    bad = draft; bad.size = "xlarge"
    #expect(bad.request(catalog: catalog) == .failure(.unknownSize))
    bad = draft; bad.goldenID = "g-web-modal"; bad.ttlSeconds = 86_401
    #expect(bad.request(catalog: catalog) == .failure(.ttlOutOfRange))
    bad = draft; bad.harness = "opencode"
    #expect(bad.request(catalog: catalog) == .failure(.missingHarness))
}

// MARK: Launching and refusals

@Test func launchIsSentOnceOnTheSizedRouteAndReturnsTheNewSandbox() async throws {
    let receipt = #"{"sandbox":{"id":"\#(newSandbox)","provider":"boat","providerSandboxId":"bx_1","goldenId":"g-web","orgId":"org-a","ownerId":"u1","harness":"claude","status":"running","conversationIds":["c1"],"createdAt":"2026-11-10T10:00:00.000Z","stoppedAt":null,"deletedAt":null,"statusReason":null,"repositoryDir":null,"model":"model-a","reasoningEffort":"medium","boatId":"bx_1"},"golden":{},"promptId":"p1","conversationId":"c1","ttlSeconds":14400,"expiresAt":"2026-11-10T14:00:00.000Z","github":{"status":"connected","login":null,"message":null}}"#
    let (client, transport) = try await signedIn([.init(status: 200, body: receipt)])
    let catalog = try catalog()
    var draft = SandboxLaunchDraft(catalog: catalog)
    draft.prompt = "Go"
    let result = try await client.launchSandbox(try draft.request(catalog: catalog).get())
    #expect(result.sandbox.id == newSandbox)
    #expect(result.promptId == "p1")
    let request = try #require(await transport.requests.last)
    #expect(request.url?.path == "/api/v1/sandbox/launch-sized-v1")
    #expect(request.timeoutInterval == 600)
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-access")
}

@Test func aLostAnswerIsUnconfirmedAndNeverResent() async throws {
    let (client, transport) = try await signedIn([.init(status: 502, body: "upstream details")])
    let catalog = try catalog()
    var draft = SandboxLaunchDraft(catalog: catalog)
    draft.prompt = "Go"
    let request = try draft.request(catalog: catalog).get()
    await #expect(throws: SandboxLaunchFailure.unconfirmed) { _ = try await client.launchSandbox(request) }
    // The transport now times out: still unconfirmed, and each call sent exactly one request.
    await #expect(throws: SandboxLaunchFailure.unconfirmed) { _ = try await client.launchSandbox(request) }
    #expect(await transport.requests.count == 4)
}

@Test func refusalsKeepSafeServerRemediesAndHidePostStartOutput() {
    func classify(_ status: Int, _ body: String) -> SandboxLaunchFailure {
        SandboxLaunchFailure.classify(status: status, body: Data(body.utf8))
    }
    guard case .refused(let invalid) = classify(400, #"{"error":{"code":"invalid_request","message":"That reasoning effort is not available for model-b.\nUse one of: low, high."}}"#) else {
        Issue.record("Expected a refusal"); return
    }
    #expect(invalid.detail == "That reasoning effort is not available for model-b. Use one of: low, high.")
    // Status and code pairs as the control API answers them (VaultError STATUS, ProviderError).
    guard case .refused(let missing) = classify(404, #"{"error":{"code":"missing_credential","message":"Run 'armada creds set claude-oauth'."}}"#) else {
        Issue.record("Expected a refusal"); return
    }
    #expect(missing.title == "No model account for this agent")
    #expect(missing.detail == "Run 'armada creds set claude-oauth'.")
    // Credential-resolution messages are authored by Armada, not provider or init output.
    // A provider credential failure must not be explained as merely a missing model account.
    for (code, message) in [
        ("missing_credential", "Your org has no Modal token pair.\nAsk an org admin to connect Modal."),
        ("no_credentials", "The stored Codex auth.json is not valid JSON."),
    ] {
        let body = String(decoding: try! JSONSerialization.data(withJSONObject: [
            "error": ["code": code, "message": message]
        ]), as: UTF8.self)
        guard case .refused(let credential) = classify(404, body) else {
            Issue.record("Credential resolution failed before launch"); return
        }
        #expect(credential.detail == message.replacingOccurrences(of: "\n", with: " "))
    }
    // A provider's non-allocating refusal of the fork arrives as 503 with its code.
    guard case .refused(let plan) = classify(503, #"{"error":{"code":"payment_required","message":"x"}}"#) else {
        Issue.record("Expected a refusal"); return
    }
    #expect(plan.title == "Provider plan limit reached")
    guard case .refused(let notConnected) = classify(503, #"{"error":{"code":"provider_not_configured","message":"Modal is not configured."}}"#) else {
        Issue.record("Expected a refusal"); return
    }
    #expect(notConnected.title == "Provider not connected")
    guard case .refused(let refused) = classify(422, #"{"error":{"code":"credential_refused"}}"#) else {
        Issue.record("Credential refusal must be actionable"); return
    }
    #expect(refused.title == "Account credential refused")
    #expect(refused.hint.contains("owner"))
    #expect(refused.hint.contains("reconnect"))
    for code in ["provider_unavailable", "dependency_unavailable", "outcome_unknown"] {
        #expect(classify(503, "{\"error\":{\"code\":\"\(code)\"}}") == .unconfirmed)
    }
    // Legacy unknown failures remain unproven.
    #expect(classify(503, #"{"error":{"code":"unavailable","message":"x"}}"#) == .unconfirmed)
    // After the fork: a sandbox may exist, and its raw output is never shown.
    guard case .failedAfterStart(let setup) = classify(400, #"{"error":{"code":"init_failed","message":"npm ci exited 1: secret-looking output"}}"#) else {
        Issue.record("Expected a failure after start"); return
    }
    #expect(setup.detail == nil)
    #expect(setup.title == "Golden setup failed")
    // A missing route allocated nothing; a server error or the legacy `unknown` code proves nothing.
    #expect(classify(404, "Not Found") == .refused(SandboxLaunchFailure.refusal(code: "", message: nil)))
    #expect(classify(500, #"{"error":{"code":"unavailable","message":"x"}}"#) == .unconfirmed)
    #expect(classify(400, #"{"error":{"code":"unknown","message":"x"}}"#) == .unconfirmed)
    // #962: a code this build does not know, answered as a 4xx with the server's reason, is a
    // refusal that shows that reason; without one, or with an uncertain code, nothing is proven.
    guard case .refused(let later) = classify(422, #"{"error":{"code":"quota_exceeded","message":"Your organization reached\nits sandbox quota."}}"#) else {
        Issue.record("Expected a refusal"); return
    }
    #expect(later.code == "quota_exceeded" && later.title == "Armada refused this launch")
    #expect(later.detail == "Your organization reached its sandbox quota.")
    #expect(classify(422, #"{"error":{"code":"quota_exceeded"}}"#) == .unconfirmed)
    #expect(classify(400, #"{"error":{"code":"quota_exceeded","message":" "}}"#) == .unconfirmed)
    #expect(classify(409, #"{"error":{"code":"outcome_unknown","message":"x"}}"#) == .unconfirmed)
    let long = String(repeating: "a", count: 400)
    guard case .refused(let bounded) = classify(409, #"{"error":{"code":"conflict","message":"\#(long)"}}"#) else {
        Issue.record("Expected a refusal"); return
    }
    #expect(bounded.detail?.count == 300)
}

@Test func signOutDuringLaunchIsReportedAsSuch() async throws {
    let (client, _) = try await signedIn([.init(status: 401, body: #"{"error":{"code":"unauthorized","message":"x"}}"#)])
    let catalog = try catalog()
    var draft = SandboxLaunchDraft(catalog: catalog)
    draft.prompt = "Go"
    await #expect(throws: SandboxLaunchFailure.signedOut) { _ = try await client.launchSandbox(try draft.request(catalog: catalog).get()) }
}

@Test func aLaunchThatNeverLeftTheDeviceIsNotSentRatherThanUnconfirmed() async throws {
    // Offline: the transport fails before connecting, so the launch was never sent.
    let offline = try await signedIn([], offline: true)
    let catalog = try catalog()
    var draft = SandboxLaunchDraft(catalog: catalog)
    draft.prompt = "Go"
    let request = try draft.request(catalog: catalog).get()
    await #expect(throws: SandboxLaunchFailure.notSent) { _ = try await offline.0.launchSandbox(request) }

    // An expired session that cannot be refreshed: nothing reaches the launch route.
    let expired = #"{"accessToken":"fixture-access","refreshToken":"fixture-refresh","expiresAt":"2000-01-01T00:00:00Z"}"#
    // Sign-in and the organization read each refresh into another already-expired session.
    let transport = LaunchTransport([
        .init(status: 200, body: expired), .init(status: 200, body: expired), .init(status: 200, body: orgs),
        .init(status: 503, body: "{}")
    ])
    let client = try ArmadaClient(transport: transport, storage: LaunchMemoryStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    await #expect(throws: SandboxLaunchFailure.notSent) { _ = try await client.launchSandbox(request) }
    #expect(await transport.requests.map { $0.url!.path }.last == "/api/v1/auth/refresh")
}
