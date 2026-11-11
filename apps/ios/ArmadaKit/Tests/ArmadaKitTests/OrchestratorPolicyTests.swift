import Foundation
import Testing
@testable import ArmadaKit

// Synthetic, non-authorizing fixtures; no clock waits, no network.
private final class PolicyStorage: SessionStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    func load() -> Data? { lock.withLock { data } }
    func save(_ value: Data) { lock.withLock { data = value } }
    func remove() { lock.withLock { data = nil } }
}
private actor PolicyTransport: ArmadaTransport {
    private var replies: [(Int, String)]
    private(set) var requests: [URLRequest] = []
    init(_ replies: [(Int, String)]) { self.replies = replies }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        guard !replies.isEmpty else { throw URLError(.badServerResponse) }
        let (status, body) = replies.removeFirst()
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}
private let session = #"{"accessToken":"fixture-access","refreshToken":"fixture-refresh","expiresAt":"2099-01-01T00:00:00Z"}"#
private let orgs = #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#

private func signedIn(_ replies: [(Int, String)]) async throws -> (ArmadaClient, PolicyTransport, PolicyStorage) {
    let transport = PolicyTransport([(200, session), (200, orgs)] + replies)
    let storage = PolicyStorage()
    let client = try ArmadaClient(transport: transport, storage: storage)
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    return (client, transport, storage)
}

/// Capabilities as the server sends them with pairs configured: one enabled pair (modal × codex),
/// a disabled one with its reason, and a provider (`future`) this app has never heard of.
private let capabilities = #"""
{"version":1,"enabled":true,"reason":null,
 "pairs":[
  {"provider":"boat","harness":"claude","requested":true,"enabled":false,"continuity":"best_effort","reason":"boat_native_checkpoint_restore_unavailable"},
  {"provider":"modal","harness":"claude","requested":false,"enabled":false,"continuity":"native","reason":"native_resume_driver_unavailable"},
  {"provider":"modal","harness":"codex","requested":true,"enabled":true,"continuity":"native","reason":null},
  {"provider":"future","harness":"pilot","requested":true,"enabled":true,"reason":null}],
 "harnesses":[
  {"harness":"claude","defaultModel":"c-1","defaultReasoningEffort":"medium","reasoningEfforts":["low","medium"],
   "models":[{"id":"c-1","label":"C One","reasoningEfforts":["low","medium"]}],"accountKinds":["claude_oauth","anthropic"]},
  {"harness":"codex","defaultModel":"x-1","defaultReasoningEffort":"medium","reasoningEfforts":["low","medium","high"],
   "models":[{"id":"x-1","label":"X One","reasoningEfforts":["medium","high"]}],"accountKinds":["openai","codex_auth"]},
  {"harness":"pilot","defaultModel":"p-1","defaultReasoningEffort":"low","reasoningEfforts":["low"],
   "models":[],"accountKinds":["pilot_key"]}],
 "delegatedWaits":{"enabled":false,"reason":"admit_wait_not_supported"}}
"""#
private let goldens = #"""
{"goldens":[
 {"id":"g-modal","name":"web","orgId":"org-a","visibility":"org","ownerId":"u","provider":"modal","providerSnapshotId":"snap","providerSandboxId":null,"modal":null,"boatSnapshotId":null,"boatSandboxId":null,"repos":2,"config":{"repos":[{"url":"u","branch":"main","dir":"web"},{"url":"u","branch":"main","dir":"api"}],"init":[]}},
 {"id":"g-boat","name":"boat","orgId":"org-a","visibility":"org","ownerId":"u","provider":"boat","providerSnapshotId":"snap","providerSandboxId":null,"modal":null,"boatSnapshotId":"snap","boatSandboxId":null,"repos":0,"config":{"repos":[],"init":[]}},
 {"id":"g-draft","name":"draft","orgId":"org-a","visibility":"private","ownerId":"u","provider":"modal","providerSnapshotId":null,"providerSandboxId":null,"modal":null,"boatSnapshotId":null,"boatSandboxId":null,"repos":0,"config":{"repos":[],"init":[]}},
 {"id":"g-future","name":"next","orgId":"org-a","visibility":"org","ownerId":"u","provider":"future","providerSnapshotId":"snap","providerSandboxId":null,"modal":null,"boatSnapshotId":null,"boatSandboxId":null,"repos":0,"config":{"repos":[],"init":[]}},
 {"id":"g-other","name":"elsewhere","orgId":"org-b","visibility":"org","ownerId":"u","provider":"modal","providerSnapshotId":"snap","providerSandboxId":null,"modal":null,"boatSnapshotId":null,"boatSandboxId":null,"repos":0,"config":{"repos":[],"init":[]}}]}
"""#
private let credentials = #"""
{"user":[
  {"id":"00000000-0000-4000-8000-000000000001","name":"Mine","kind":"openai","status":"active","isDefault":false,"createdAt":null},
  {"id":"00000000-0000-4000-8000-000000000002","name":"Team default","kind":"codex_auth","status":"active","isDefault":true,"createdAt":null},
  {"id":"00000000-0000-4000-8000-000000000003","name":"Old","kind":"openai","status":"active","expiresAt":"2000-01-01T00:00:00Z","createdAt":null},
  {"id":"00000000-0000-4000-8000-000000000004","name":"Gone","kind":"openai","status":"revoked","createdAt":null},
  {"kind":"openai","createdAt":null}],
 "orgs":[
  {"id":"org-a","name":"Team","role":"member","credentials":[{"kind":"boat","createdAt":null},{"id":"00000000-0000-4000-8000-000000000005","name":"Org Claude","kind":"claude_oauth","status":"active","createdAt":null}]},
  {"id":"org-b","name":"Other","role":"member","credentials":[{"id":"00000000-0000-4000-8000-000000000006","name":"Elsewhere","kind":"openai","status":"active","createdAt":null}]}]}
"""#

private let accCodex = "00000000-0000-4000-8000-000000000001"
private let accDefault = "00000000-0000-4000-8000-000000000002"
private let accClaude = "00000000-0000-4000-8000-000000000005"
private let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)

private func catalog() async throws -> (OrchestratorCreateCatalog, PolicyTransport) {
    let (client, transport, _) = try await signedIn([(200, capabilities), (200, goldens), (200, credentials)])
    let result = OrchestratorCreateCatalog(capabilities: try await client.orchestratorCapabilities(),
                                           goldens: try await client.launchGoldens(), accounts: try await client.launchAccounts(),
                                           now: fixedNow)
    return (result, transport)
}

@Test func createSourcesUseTheCliRoutesForTheSelectedOrganizationOnly() async throws {
    let (catalog, transport) = try await catalog()
    let requests = await transport.requests
    #expect(requests.map(\.url!.path).suffix(3) == ["/api/v1/orchestrators/capabilities", "/api/v1/golden/list", "/api/v1/creds/list"])
    for request in requests.suffix(2) {
        #expect(request.httpMethod == "POST")
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
        #expect(body == ["org": "org-a"])
    }
    #expect(!catalog.goldens.contains { $0.id == "g-other" })
    // Unnamed, expired, revoked and other organizations' accounts are never offered.
    #expect(Set(catalog.accounts.map(\.id)) == [accCodex, accDefault, accClaude])
}

@Test func onlyEnabledPairsAreOfferedAndADisabledPairIsExplained() async throws {
    let (catalog, _) = try await catalog()
    let modal = try #require(catalog.goldens.first { $0.id == "g-modal" })
    let offers = catalog.offers(for: modal)
    #expect(offers.map(\.harness) == [.codex, .claude])
    #expect(offers[0].enabled && offers[0].explanation == nil)
    #expect(!offers[1].enabled)
    #expect(offers[1].explanation == OrchestratorExplanation.text(for: "native_resume_driver_unavailable"))
    let boat = try #require(catalog.goldens.first { $0.id == "g-boat" })
    #expect(catalog.offers(for: boat).allSatisfy { !$0.enabled && $0.explanation != nil })
    // A provider and harness this build does not know are offered because the server enables them.
    let future = try #require(catalog.goldens.first { $0.id == "g-future" })
    #expect(catalog.offers(for: future).map(\.harness.rawValue) == ["pilot"])
    #expect(catalog.offers(for: future).first?.enabled == true)
    // Accounts follow the server's account kinds for the harness, the person's before the org's.
    #expect(catalog.accounts(for: .codex).map(\.id) == [accCodex, accDefault])
    #expect(catalog.accounts(for: ArmadaHarness(rawValue: "pilot")!).isEmpty)
    #expect(catalog.canCreate)
}

@Test func draftDefaultsAndValidationFollowTheServerCatalog() async throws {
    let (catalog, _) = try await catalog()
    var draft = catalog.initialDraft()
    // Ready goldens first, then by name: g-future ("next") sorts after "boat" (no enabled pair) and before "web".
    #expect(draft.goldenId == "g-future")
    let modal = try #require(catalog.goldens.first { $0.id == "g-modal" })
    catalog.adopt(golden: modal, into: &draft)
    #expect(draft.harness == .codex && draft.model == "x-1" && draft.reasoningEffort == "medium")
    #expect(draft.accountId == accDefault)
    #expect(catalog.request(orgId: "org-a", draft: draft) == .failure(.missingName))
    draft.name = "  Release  "
    draft.reasoningEffort = "low"
    #expect(catalog.request(orgId: "org-a", draft: draft) == .failure(.unsupportedEffort))
    draft.reasoningEffort = "high"
    draft.repository = "docs"
    #expect(catalog.request(orgId: "org-a", draft: draft) == .failure(.unknownRepository))
    draft.repository = "api"
    draft.idleSeconds = 60
    #expect(catalog.request(orgId: "org-a", draft: draft) == .failure(.idleOutOfRange))
    draft.idleSeconds = nil
    draft.harness = .claude
    guard case .failure(.pairDisabled(let reason)) = catalog.request(orgId: "org-a", draft: draft) else {
        Issue.record("A disabled pair must be refused"); return
    }
    #expect(reason == OrchestratorExplanation.text(for: "native_resume_driver_unavailable"))
    draft.harness = .codex
    let request = try catalog.request(orgId: "org-a", draft: draft).get()
    let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any]
    #expect(body["name"] as? String == "Release")
    #expect(body["provider"] as? String == "modal" && body["harness"] as? String == "codex")
    #expect(body["model"] as? String == "x-1" && body["reasoningEffort"] as? String == "high")
    #expect(body["modelAccountId"] as? String == accDefault && body["repo"] as? String == "api")
    #expect(body["idleSeconds"] == nil && body["size"] == nil)
    // A golden without a saved snapshot cannot start an orchestrator.
    draft.goldenId = "g-draft"
    #expect(catalog.request(orgId: "org-a", draft: draft) == .failure(.goldenNotReady))
}

@Test func aServerWithoutPairsOffersNothingToCreate() async throws {
    let (client, _, _) = try await signedIn([(200, #"{"version":1,"enabled":false,"reason":"native_conformance_required"}"#), (200, goldens), (200, credentials)])
    let catalog = OrchestratorCreateCatalog(capabilities: try await client.orchestratorCapabilities(),
                                            goldens: try await client.launchGoldens(), accounts: try await client.launchAccounts(),
                                            now: fixedNow)
    #expect(!catalog.canCreate)
    #expect(catalog.offers(for: catalog.goldens[0]).isEmpty)
}

@Test func controlsDeriveFromStateContinuityAndOpenOperations() {
    let ready = OrchestratorControls(state: "ready", continuity: "native", blockedReason: nil, revision: 3, operations: [], agentWorking: false)
    #expect(ready.phase == .ready && ready.canMessage && !ready.canSteer && ready.canStop && !ready.canResume && !ready.canRecover)
    #expect(ready.composerNote == nil)
    let working = OrchestratorControls(state: "ready", continuity: "native", blockedReason: nil, revision: 3, operations: [], agentWorking: true)
    #expect(working.canSteer)
    // Any open operation (here an unknown-outcome message) blocks every new command.
    let settling = OrchestratorControls(state: "ready", continuity: "native", blockedReason: nil, revision: 3,
                                        operations: [("message", "uncertain", 3, nil)], agentWorking: true)
    #expect(!settling.canMessage && !settling.canSteer && !settling.canStop)
    #expect(settling.open == .init(kind: "message", uncertain: true))
    #expect(settling.composerNote?.contains("still checking") == true)
    // #847: the uncertain state is never a dead end; the note says what the person can do.
    let unconfirmedSteer = OrchestratorControls(state: "blocked", continuity: "unverified", blockedReason: "runtime_uncertain", revision: 3,
                                                operations: [("create", "succeeded", 1, nil), ("message", "succeeded", 2, nil),
                                                             ("steer", "uncertain", 3, "runtime_uncertain")], agentWorking: true)
    #expect(!unconfirmedSteer.canMessage && !unconfirmedSteer.canSteer)
    #expect(unconfirmedSteer.composerNote?.contains("start a new orchestrator") == true)
    // Create is asynchronous: never send before it has succeeded.
    let creating = OrchestratorControls(state: "creating", continuity: "not_started", blockedReason: nil, revision: 3,
                                        operations: [("create", "pending", 3, nil)], agentWorking: false)
    #expect(creating.phase == .creating && !creating.canMessage && !creating.canRecover)
    let uncertainCreate = OrchestratorControls(state: "creating", continuity: "not_started", blockedReason: nil, revision: 3,
                                               operations: [("create", "uncertain", 3, nil)], agentWorking: false)
    #expect(uncertainCreate.canRecover)
    let blocked = OrchestratorControls(state: "blocked", continuity: "unverified", blockedReason: "wait_cap_exhausted", revision: 3,
                                       operations: [], agentWorking: false)
    // Nothing to settle: the server would refuse recovery, so it is not offered.
    #expect(!blocked.canRecover && blocked.canStop && !blocked.canMessage)
    #expect(blocked.phase == .blocked(explanation: OrchestratorExplanation.text(for: "wait_cap_exhausted")))
    let blockedStop = OrchestratorControls(state: "blocked", continuity: "unverified", blockedReason: "native_stop_unconfirmed",
                                           revision: 3, operations: [("stop", "uncertain", 3, nil)], agentWorking: false)
    #expect(blockedStop.canRecover && !blockedStop.canStop)
    let staleStop = OrchestratorControls(state: "blocked", continuity: "unverified", blockedReason: nil,
                                         revision: 4, operations: [("stop", "uncertain", 3, nil)], agentWorking: false)
    #expect(!staleStop.canRecover)
    // A create that failed before any machine started is settled by recovery; another failure is not.
    let failedCreate = OrchestratorControls(state: "blocked", continuity: "not_started", blockedReason: "create_preallocation_failed",
                                            revision: 1, operations: [("create", "failed", 1, "create_preallocation_failed")], agentWorking: false)
    #expect(failedCreate.canRecover && failedCreate.canStop)
    let otherFailure = OrchestratorControls(state: "blocked", continuity: "not_started", blockedReason: nil,
                                            revision: 1, operations: [("create", "failed", 1, "build_failed")], agentWorking: false)
    #expect(!otherFailure.canRecover)
    let stopped = OrchestratorControls(state: "stopped", continuity: "native", blockedReason: nil, revision: 3, operations: [], agentWorking: false)
    #expect(stopped.canResume && !stopped.canStop)
    let unverified = OrchestratorControls(state: "stopped", continuity: "unverified", blockedReason: nil, revision: 3, operations: [], agentWorking: false)
    #expect(!unverified.canResume && unverified.composerNote?.contains("could not verify") == true)
    let lost = OrchestratorControls(state: "ready", continuity: "lost", blockedReason: nil, revision: 3, operations: [], agentWorking: false)
    #expect(!lost.canMessage && lost.composerNote?.contains("lost") == true)
    let future = OrchestratorControls(state: "hibernating", continuity: "native", blockedReason: nil, revision: 3, operations: [], agentWorking: false)
    #expect(future.phase == .unknown("hibernating") && !future.canMessage && !future.canStop)
    let futureReceipt = OrchestratorControls(state: "ready", continuity: "native", blockedReason: nil,
        revision: 3, operations: [("message", "future_state", 3, nil)], agentWorking: true)
    #expect(!futureReceipt.canMessage && !futureReceipt.canStop && futureReceipt.open?.uncertain == true)
}

@Test func createProgressSettlesOnlyOnTheServersReceipt() {
    #expect(OrchestratorCreateProgress(state: "future_state", operations: [("create", "succeeded", nil)], blockedReason: nil) == .creating)
    #expect(OrchestratorCreateProgress(state: "ready", operations: [("create", "future_state", nil)], blockedReason: nil) == .creating)
    #expect(OrchestratorCreateProgress(state: "creating", operations: [("create", "pending", nil)], blockedReason: nil) == .creating)
    #expect(OrchestratorCreateProgress(state: "ready", operations: [("create", "uncertain", nil)], blockedReason: nil) == .creating)
    #expect(OrchestratorCreateProgress(state: "ready", operations: [("create", "succeeded", nil)], blockedReason: nil) == .ready)
    #expect(OrchestratorCreateProgress(state: "creating", operations: [], blockedReason: nil) == .creating)
    #expect(OrchestratorCreateProgress(state: "blocked", operations: [("create", "failed", "create_preallocation_failed")],
                                       blockedReason: "create_preallocation_failed")
            == .failed(OrchestratorExplanation.text(for: "create_preallocation_failed")))
}

@Test func pollingFollowsTransitionsAndBacksOffOnFailures() {
    #expect(OrchestratorPolling.detailDelay(state: "creating", hasOpenOperation: true, consecutiveFailures: 0) == .seconds(2))
    #expect(OrchestratorPolling.detailDelay(state: "ready", hasOpenOperation: true, consecutiveFailures: 0) == .seconds(5))
    #expect(OrchestratorPolling.detailDelay(state: "ready", hasOpenOperation: false, consecutiveFailures: 0) == nil)
    #expect(OrchestratorPolling.detailDelay(state: "stopped", hasOpenOperation: false, consecutiveFailures: 0) == nil)
    #expect(OrchestratorPolling.detailDelay(state: "ready", hasOpenOperation: false, consecutiveFailures: 1) == .seconds(2))
    #expect(OrchestratorPolling.detailDelay(state: "ready", hasOpenOperation: false, consecutiveFailures: 3) == .seconds(8))
    #expect(OrchestratorPolling.detailDelay(state: "ready", hasOpenOperation: false, consecutiveFailures: 50) == .seconds(60))
    #expect(OrchestratorPolling.listDelay(states: ["ready", "resuming"], consecutiveFailures: 0) == .seconds(5))
    #expect(OrchestratorPolling.listDelay(states: ["ready", "stopped"], consecutiveFailures: 0) == nil)
}

@Test func everyCodeGetsAPlainSentence() {
    for code in ["conflict", "unavailable", "runtime_uncertain", "not_found", "invalid_request", "create_recovered_terminated", "stop_recovered_terminated", "native_state_lost",
                 "provider_payment_required", "credential_refused", "provider_unavailable", "dependency_unavailable", "outcome_unknown",
                 "boat_conversation_unavailable", "previous_conversation_not_continued", "skillpack_credential_refused"] {
        let text = OrchestratorExplanation.text(for: code)
        #expect(!text.contains("_") && text.hasSuffix(".") && text != code)
    }
    let unknown = OrchestratorExplanation.text(for: "brand_new_code")
    #expect(unknown.contains("brand new code") && unknown.hasPrefix("Armada"))
}

@Test func recoverReplaysTheSameKeyAndAcceptsItsStopReceipt() async throws {
    let enabled = #"{"version":1,"enabled":true,"reason":null}"#
    let (client, transport, storage) = try await signedIn([
        (200, enabled),
        (503, #"{"error":{"code":"unavailable","message":"unavailable"}}"#),
        (200, enabled),
        (202, #"{"version":1,"id":"op-stop","orchestratorId":"parent-a","kind":"stop","state":"succeeded","revision":8,"errorCode":null}"#),
    ])
    let command = try await client.prepareOrchestratorMutation(id: "parent-a", action: .recover, expectedRevision: 7)
    await #expect(throws: ArmadaError.unavailable) { _ = try await client.submitOrchestratorOperation(command.id) }
    // The unknown outcome survives a relaunch and blocks a second command for the same orchestrator.
    let restored = try ArmadaClient(transport: transport, storage: storage)
    try await restored.restore()
    #expect(await restored.pendingOperations.first?.state == .uncertain)
    await #expect(throws: ArmadaError.conflict) {
        _ = try await restored.prepareOrchestratorMutation(id: "parent-a", action: .stop, expectedRevision: 7)
    }
    let receipt = try await restored.submitOrchestratorOperation(command.id)
    #expect(receipt.kind == .stop && receipt.state == .succeeded)
    let posts = await transport.requests.filter { $0.url!.path == "/api/v1/orchestrators/parent-a/recover" }
    #expect(posts.count == 2)
    #expect(posts[0].httpBody == posts[1].httpBody)
    let key = posts[0].value(forHTTPHeaderField: "Idempotency-Key")
    #expect(key != nil && key == posts[1].value(forHTTPHeaderField: "Idempotency-Key"))
    let body = try JSONSerialization.jsonObject(with: posts[0].httpBody!) as! [String: Any]
    #expect(body["expectedRevision"] as? Int == 7 && body["orgId"] as? String == "org-a" && body["text"] == nil)
}

@Test func eachPairSaysWhetherAResumeIsGuaranteed() async throws {
    let (catalog, _) = try await catalog()
    let modal = try #require(catalog.goldens.first { $0.id == "g-modal" })
    #expect(catalog.offers(for: modal).map(\.continuityLabel) == ["Resume guaranteed", "Resume guaranteed"])
    let boat = try #require(catalog.goldens.first { $0.id == "g-boat" })
    #expect(catalog.offers(for: boat).first?.continuityLabel == "Resume not guaranteed")
    // An older server reports no continuity: nothing is claimed.
    let future = try #require(catalog.goldens.first { $0.id == "g-future" })
    #expect(catalog.offers(for: future).first?.continuityLabel == nil)
}

@Test func theAccountIsChosenOnlyWhenThereIsAChoice() async throws {
    let (catalog, _) = try await catalog()
    // Claude runs on one org account: shown, preselected, no picker.
    #expect(!catalog.offersAccountChoice(for: .claude))
    #expect(catalog.defaultAccount(for: .claude)?.id == accClaude)
    // Codex has two personal accounts and a personal default: a picker, the default preselected.
    #expect(catalog.offersAccountChoice(for: .codex))
    #expect(catalog.defaultAccount(for: .codex)?.id == accDefault)
    // Two accounts and no default: the person chooses; the request is refused until they do.
    let ambiguous = OrchestratorCreateCatalog(
        capabilities: try JSONDecoder().decode(OrchestratorCapabilities.self, from: Data(capabilities.utf8)),
        goldens: catalog.goldens,
        accounts: [
            LaunchAccount(id: accCodex, name: "A", kind: "openai", scope: .user, isDefault: false, status: "active", expiresAt: nil),
            LaunchAccount(id: accDefault, name: "B", kind: "codex_auth", scope: .user, isDefault: false, status: "active", expiresAt: nil),
            LaunchAccount(id: accClaude, name: "Org", kind: "openai", scope: .org, isDefault: true, status: "active", expiresAt: nil),
        ],
        now: fixedNow
    )
    #expect(ambiguous.accounts(for: .codex).map(\.id) == [accCodex, accDefault, accClaude])
    #expect(ambiguous.defaultAccount(for: .codex) == nil)
    var draft = ambiguous.initialDraft()
    let modal = try #require(ambiguous.goldens.first { $0.id == "g-modal" })
    ambiguous.adopt(golden: modal, into: &draft)
    draft.name = "Release"
    #expect(draft.accountId == nil)
    #expect(ambiguous.request(orgId: "org-a", draft: draft) == .failure(.missingAccount))
    draft.accountId = accClaude
    #expect(try ambiguous.request(orgId: "org-a", draft: draft).get().modelAccountId == accClaude)
}

@Test func aModelChangeKeepsOnlyAnEffortTheModelAccepts() async throws {
    let (catalog, _) = try await catalog()
    var draft = OrchestratorCreateCatalog.Draft(harness: .codex, model: "x-1", reasoningEffort: "high")
    // Another model id takes the harness's efforts, which include "high".
    catalog.adopt(model: "x-custom", into: &draft)
    #expect(draft.model == "x-custom" && draft.reasoningEffort == "high")
    draft.reasoningEffort = "low"
    // x-1 accepts medium and high only: back to the harness default.
    catalog.adopt(model: "x-1", into: &draft)
    #expect(draft.reasoningEffort == "medium")
}

private let createConfiguration = #"{"version":1,"orgId":"org-a","name":"Release","goldenId":"g-modal","provider":"modal","harness":"codex","model":"x-1","modelAccountId":"00000000-0000-4000-8000-000000000002"}"#
private func createDetail(state: String, operation: String, blockedReason: String? = nil) -> String {
    let blocked = blockedReason.map { #","blockedReason":"\#($0)""# } ?? ""
    return #"{"version":1,"orchestrator":{"version":1,"id":"orch-new","ownerId":"owner-a","configuration":\#(createConfiguration),"state":"\#(state)","revision":1,"continuity":"not_started","createdAt":"2026-11-10T00:00:00Z","updatedAt":"2026-11-10T00:00:00Z","lastActivityAt":"2026-11-10T00:00:00Z","skillRevision":"v1"\#(blocked)},"operations":[\#(operation)],"waits":[],"childSandboxIds":[]}"#
}
private func createReceipt(_ state: String, errorCode: String? = nil) -> String {
    let code = errorCode.map { #""\#($0)""# } ?? "null"
    return #"{"version":1,"id":"op-create","orchestratorId":"orch-new","kind":"create","state":"\#(state)","revision":1,"errorCode":\#(code)}"#
}
private actor Sleeps {
    private(set) var delays: [Duration] = []
    func record(_ delay: Duration) { delays.append(delay) }
}

@Test func anAcceptedCreateIsFollowedUntilTheServerSettlesIt() async throws {
    let enabled = #"{"version":1,"enabled":true,"reason":null}"#
    let (client, transport, _) = try await signedIn([
        (200, enabled),
        (202, createReceipt("pending")),
        (200, createDetail(state: "creating", operation: createReceipt("pending"))),
        (503, #"{"error":{"code":"unavailable","message":"unavailable"}}"#),
        (200, createDetail(state: "ready", operation: createReceipt("pending"))),
        (200, createDetail(state: "ready", operation: createReceipt("succeeded"))),
    ])
    let (catalog, _) = try await catalog()
    var draft = catalog.initialDraft()
    catalog.adopt(golden: try #require(catalog.goldens.first { $0.id == "g-modal" }), into: &draft)
    draft.name = "Release"
    let command = try await client.prepareOrchestratorCreate(try catalog.request(orgId: "org-a", draft: draft).get())
    let receipt = try await client.submitOrchestratorOperation(command.id)
    #expect(receipt.state == .pending && receipt.orchestratorId == "orch-new")

    let sleeps = Sleeps()
    let progress = try await client.followOrchestratorCreate(command.id) { await sleeps.record($0) }
    #expect(progress == .ready)
    // Creating polls quickly; a failed read backs off; a ready state with its create still open keeps waiting.
    #expect(await sleeps.delays == [.seconds(2), .seconds(2), .seconds(5)])
    #expect(await client.pendingOperations.first { $0.id == command.id }?.state == .succeeded)

    let requests = await transport.requests
    let posts = requests.filter { $0.httpMethod == "POST" && $0.url!.path == "/api/v1/orchestrators" }
    #expect(posts.count == 1)
    #expect(posts[0].value(forHTTPHeaderField: "Idempotency-Key") != nil)
    // Following only reads the new orchestrator; it never sends the create again.
    let follow = requests.suffix(4)
    #expect(follow.allSatisfy { $0.httpMethod == "GET" && $0.url!.path == "/api/v1/orchestrators/orch-new" })
    #expect(follow.allSatisfy { $0.value(forHTTPHeaderField: "Idempotency-Key") == nil })
}

@Test func aFailedCreateEndsTheFollowWithThePlainReason() async throws {
    let enabled = #"{"version":1,"enabled":true,"reason":null}"#
    let (client, _, _) = try await signedIn([
        (200, enabled),
        (202, createReceipt("pending")),
        (200, createDetail(state: "blocked", operation: createReceipt("failed", errorCode: "create_preallocation_failed"),
                           blockedReason: "create_preallocation_failed")),
    ])
    let (catalog, _) = try await catalog()
    var draft = catalog.initialDraft()
    catalog.adopt(golden: try #require(catalog.goldens.first { $0.id == "g-modal" }), into: &draft)
    draft.name = "Release"
    let command = try await client.prepareOrchestratorCreate(try catalog.request(orgId: "org-a", draft: draft).get())
    _ = try await client.submitOrchestratorOperation(command.id)
    let sleeps = Sleeps()
    let progress = try await client.followOrchestratorCreate(command.id) { await sleeps.record($0) }
    #expect(progress == .failed(OrchestratorExplanation.text(for: "create_preallocation_failed")))
    #expect(await sleeps.delays.isEmpty)
    #expect(await client.pendingOperations.first { $0.id == command.id }?.state == .failed)
}

@Test func onlyAnAcceptedCreateCanBeFollowed() async throws {
    let (client, transport, _) = try await signedIn([])
    let (catalog, _) = try await catalog()
    var draft = catalog.initialDraft()
    catalog.adopt(golden: try #require(catalog.goldens.first { $0.id == "g-modal" }), into: &draft)
    draft.name = "Release"
    let command = try await client.prepareOrchestratorCreate(try catalog.request(orgId: "org-a", draft: draft).get())
    // Never sent, so there is no orchestrator to read yet.
    await #expect(throws: ArmadaError.conflict) {
        _ = try await client.followOrchestratorCreate(command.id) { _ in }
    }
    #expect(await transport.requests.allSatisfy { !$0.url!.path.hasPrefix("/api/v1/orchestrators") })
}

@Test func followingStopsAfterRepeatedFailedReads() async throws {
    let enabled = #"{"version":1,"enabled":true,"reason":null}"#
    let outage = #"{"error":{"code":"unavailable","message":"unavailable"}}"#
    let (client, _, _) = try await signedIn([(200, enabled), (202, createReceipt("pending")), (503, outage), (503, outage)])
    let (catalog, _) = try await catalog()
    var draft = catalog.initialDraft()
    catalog.adopt(golden: try #require(catalog.goldens.first { $0.id == "g-modal" }), into: &draft)
    draft.name = "Release"
    let command = try await client.prepareOrchestratorCreate(try catalog.request(orgId: "org-a", draft: draft).get())
    _ = try await client.submitOrchestratorOperation(command.id)
    let sleeps = Sleeps()
    await #expect(throws: ArmadaError.unavailable) {
        _ = try await client.followOrchestratorCreate(command.id, maxFailedReads: 2) { await sleeps.record($0) }
    }
    #expect(await sleeps.delays == [.seconds(2)])
    // The accepted create stays saved for the list to settle later.
    #expect(await client.pendingOperations.first { $0.id == command.id }?.state == .pending)
}

// #941: since #806 the server records `connections_add` and `connections_remove` receipts. The 2.19
// detail and events of an orchestrator whose connections changed must still decode (the shapes are
// those the 2.19 server answers), keeping the kind as reported.
@Test func receiptsOfConnectionChangesDecodeInDetailAndEvents() async throws {
    func receipt(_ id: String, _ kind: String, _ revision: Int) -> String {
        #"{"version":1,"id":"\#(id)","orchestratorId":"orch-new","kind":"\#(kind)","state":"succeeded","revision":\#(revision),"errorCode":null}"#
    }
    let operations = [receipt("op-create", "create", 1), receipt("op-add", "connections_add", 2), receipt("op-remove", "connections_remove", 3)]
    let detail = createDetail(state: "ready", operation: operations.joined(separator: ","))
        .replacingOccurrences(of: #""childSandboxIds":[]}"#, with: #""childSandboxIds":[],"connections":[{"id":"c-1","name":"Linear"}]}"#)
    let events = #"{"version":1,"events":[{"kind":"connections","connections":[],"id":"3","orchestratorId":"orch-new","at":"2026-11-11T00:00:00Z","revision":1},"#
        + #"{"kind":"operation","operation":\#(receipt("op-add", "connections_add", 2)),"id":"4","orchestratorId":"orch-new","at":"2026-11-11T00:00:01Z","revision":2}],"#
        + #""cursor":"c4","hasMore":false}"#
    let (client, _, _) = try await signedIn([(200, detail), (200, events)])
    let read = try await client.orchestratorDetail(id: "orch-new")
    #expect(read.operations.map(\.kind.rawValue) == ["create", "connections_add", "connections_remove"])
    #expect(OrchestratorCreateProgress(detail: read) == .ready)
    #expect(OrchestratorControls(detail: read, agentWorking: false).canMessage)
    let changing = OrchestratorControls(state: "ready", continuity: "native", blockedReason: nil, revision: 4,
                                        operations: [("connections_add", "pending", 4, nil)], agentWorking: false)
    #expect(changing.composerNote == "Waiting for the connections add to finish.")
    let page = try await client.orchestratorEvents(id: "orch-new", backward: true)
    #expect(page.events.count == 2)
    guard case .operation(let operation) = page.events[1].body else { Issue.record("operation event"); return }
    #expect(operation.kind.rawValue == "connections_add")
}

// #941: a create the provider refused for billing (#919) says why, in words. Only Boat refuses so,
// and Boat recovery settles no create, so recovery is not offered.
@Test func aCreateRefusedByTheProviderSaysWhyInWords() {
    let refused = OrchestratorControls(state: "blocked", continuity: "not_started", blockedReason: "provider_payment_required",
                                       revision: 1, operations: [("create", "failed", 1, "provider_payment_required")], agentWorking: false)
    let reason = OrchestratorExplanation.text(for: "provider_payment_required")
    #expect(!reason.contains("_") && !reason.contains("did not explain"))
    #expect(!refused.canRecover && refused.composerNote == "Creation failed. " + reason)
    #expect(OrchestratorCreateProgress(state: "blocked", operations: [("create", "failed", "provider_payment_required")],
                                       blockedReason: "provider_payment_required") == .failed(reason))
    let preallocation = OrchestratorControls(state: "stopped", continuity: "not_started",
        blockedReason: "provider_payment_required", revision: 1,
        operations: [("create", "failed", 1, nil)], agentWorking: false)
    #expect(preallocation.composerNote == "Creation failed. " + reason)
    #expect(!preallocation.canRecover && !preallocation.canStop && !preallocation.canResume)
    #expect(OrchestratorCreateProgress(state: "stopped", operations: [("create", "failed", nil)],
        blockedReason: "provider_payment_required") == .failed(reason))
    // A create whose machine was stopped after it failed says why it failed, not only that it stopped.
    let stopped = OrchestratorControls(state: "stopped", continuity: "not_started", blockedReason: nil, revision: 1,
                                       operations: [("create", "failed", 1, "skillpack_install_nonzero")], agentWorking: false)
    #expect(stopped.composerNote == "Creation failed. " + OrchestratorExplanation.text(for: "skillpack_install_nonzero"))
}

// #941: a structured create refusal keeps the server's closed reason up to the person: the 2.19
// envelope `{"error":{"code","message"}}` with 422 `credential_refused` is explained in words, and a
// first attempt refused so is recorded as never admitted (like `invalid_request`), so it can be dismissed.
// An unknown outcome (503 `outcome_unknown`) stays uncertain: nothing is claimed about admission.
@Test func aStructuredCreateRefusalKeepsTheServersReasonAndIsNotAdmitted() async throws {
    let enabled = #"{"version":1,"enabled":true,"reason":null}"#
    let (client, _, _) = try await signedIn([
        (200, enabled),
        (422, #"{"error":{"code":"credential_refused","message":"credential_refused"}}"#),
        (200, enabled),
        (400, #"{"error":{"code":"name_reserved","message":"That name is reserved."}}"#),
        (200, enabled),
        (503, #"{"error":{"code":"outcome_unknown","message":"outcome_unknown","admission":"unknown"}}"#),
    ])
    let (catalog, _) = try await catalog()
    var draft = catalog.initialDraft()
    catalog.adopt(golden: try #require(catalog.goldens.first { $0.id == "g-modal" }), into: &draft)
    draft.name = "Release"
    let refused = try await client.prepareOrchestratorCreate(try catalog.request(orgId: "org-a", draft: draft).get())
    do {
        _ = try await client.submitOrchestratorOperation(refused.id)
        Issue.record("The refusal must be thrown")
    } catch let error as ArmadaError {
        #expect(error == .refused(code: "credential_refused"))
        #expect(error.localizedDescription == OrchestratorExplanation.text(for: "credential_refused"))
        #expect(!error.localizedDescription.contains("_"))
    }
    let saved = try #require(await client.pendingOperations.first { $0.id == refused.id })
    #expect(saved.rejectedBeforeAdmission && saved.canDiscard)
    try await client.discardOrchestratorOperation(refused.id)

    // #962: a 400 code this build does not know is still a refusal, never an unknown outcome.
    let later = try await client.prepareOrchestratorCreate(try catalog.request(orgId: "org-a", draft: draft).get())
    await #expect(throws: ArmadaError.refused(code: "name_reserved", message: "That name is reserved.")) { _ = try await client.submitOrchestratorOperation(later.id) }
    #expect(try #require(await client.pendingOperations.first { $0.id == later.id }).canDiscard)
    try await client.discardOrchestratorOperation(later.id)

    let unknown = try await client.prepareOrchestratorCreate(try catalog.request(orgId: "org-a", draft: draft).get())
    await #expect(throws: ArmadaError.unavailable) { _ = try await client.submitOrchestratorOperation(unknown.id) }
    let open = try #require(await client.pendingOperations.first { $0.id == unknown.id })
    #expect(open.state == .uncertain && !open.canDiscard)
}

// #971: a recognized refusal code must not hide the server's more specific remedy.
// Exercise the public create submission boundary, including its durable admission classification.
@Test func recognizedCreateRefusalPreservesReadableServerDetail() async throws {
    for (message, expected) in [
        ("Reconnect the selected model account in Settings.", "Reconnect the selected model account in Settings."),
        ("  Reconnect\n the selected\taccount.  ", "Reconnect the selected account."),
        ("credential_refused", OrchestratorExplanation.text(for: "credential_refused")),
        (" \n\t ", OrchestratorExplanation.text(for: "credential_refused")),
        (String(repeating: "x", count: 320), String(repeating: "x", count: 299) + "…"),
    ] {
        let body = String(decoding: try JSONSerialization.data(withJSONObject: [
            "error": ["code": "credential_refused", "message": message]
        ]), as: UTF8.self)
        let (client, _, _) = try await signedIn([
            (200, #"{"version":1,"enabled":true,"reason":null}"#),
            (422, body),
        ])
        let (catalog, _) = try await catalog()
        var draft = catalog.initialDraft()
        catalog.adopt(golden: try #require(catalog.goldens.first { $0.id == "g-modal" }), into: &draft)
        draft.name = "Release"
        let operation = try await client.prepareOrchestratorCreate(try catalog.request(orgId: "org-a", draft: draft).get())
        do {
            _ = try await client.submitOrchestratorOperation(operation.id)
            Issue.record("Expected a refusal")
        } catch let error as ArmadaError {
            #expect(error.localizedDescription == expected)
        }
        let saved = try #require(await client.pendingOperations.first { $0.id == operation.id })
        #expect(saved.rejectedBeforeAdmission && saved.canDiscard)
    }
}

// #941: production 2.19 starts a new orchestrator's events with a `connections` event, then its
// create receipt. Exact shape of the 2.19 server's first backward page.
@Test func aNewOrchestratorsFirstEventsDecodeInTheProductionShape() async throws {
    let page = #"{"version":1,"events":[{"kind":"connections","connections":[],"id":"3","orchestratorId":"9ae5c175-e0dd-47fc-b920-5321190108db","at":"2026-11-11T07:56:35.925Z","revision":1},{"kind":"operation","operation":{"id":"a1659104-d958-43d6-97fb-d270d4fd9401","kind":"create","state":"succeeded","version":1,"revision":1,"errorCode":null,"orchestratorId":"9ae5c175-e0dd-47fc-b920-5321190108db"},"id":"4","orchestratorId":"9ae5c175-e0dd-47fc-b920-5321190108db","at":"2026-11-11T07:56:35.925Z","revision":1}],"cursor":"after-4","olderCursor":"after-3","hasMore":false}"#
    let (client, _, _) = try await signedIn([(200, page)])
    let read = try await client.orchestratorEvents(id: "9ae5c175-e0dd-47fc-b920-5321190108db", backward: true)
    #expect(read.events.map(\.id) == ["3", "4"] && read.cursor == "after-4" && read.olderCursor == "after-3")
    guard case .unknown(let kind, _) = read.events[0].body else { Issue.record("connections event"); return }
    #expect(kind == "connections")
    guard case .operation(let create) = read.events[1].body else { Issue.record("create receipt"); return }
    #expect(create.kind == .create && create.state == .succeeded && create.revision == 1)
}
