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
  {"provider":"boat","harness":"claude","requested":true,"enabled":false,"reason":"boat_native_checkpoint_restore_unavailable"},
  {"provider":"modal","harness":"claude","requested":false,"enabled":false,"reason":"native_resume_driver_unavailable"},
  {"provider":"modal","harness":"codex","requested":true,"enabled":true,"reason":null},
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
  {"id":"acc-codex","name":"Mine","kind":"openai","status":"active","isDefault":false,"createdAt":null},
  {"id":"acc-default","name":"Team default","kind":"codex_auth","status":"active","isDefault":true,"createdAt":null},
  {"id":"acc-expired","name":"Old","kind":"openai","status":"active","expiresAt":"2000-01-01T00:00:00Z","createdAt":null},
  {"id":"acc-revoked","name":"Gone","kind":"openai","status":"revoked","createdAt":null},
  {"kind":"openai","createdAt":null}],
 "orgs":[
  {"id":"org-a","name":"Team","role":"member","credentials":[{"kind":"boat","createdAt":null},{"id":"acc-claude","name":"Org Claude","kind":"claude_oauth","status":"active","createdAt":null}]},
  {"id":"org-b","name":"Other","role":"member","credentials":[{"id":"acc-elsewhere","name":"Elsewhere","kind":"openai","status":"active","createdAt":null}]}]}
"""#

private func catalog() async throws -> (OrchestratorCreateCatalog, PolicyTransport) {
    let (client, transport, _) = try await signedIn([(200, capabilities), (200, goldens), (200, credentials)])
    let result = OrchestratorCreateCatalog(capabilities: try await client.orchestratorCapabilities(),
                                           goldens: try await client.goldens(), accounts: try await client.modelAccounts())
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
    #expect(Set(catalog.accounts.map(\.id)) == ["acc-codex", "acc-default", "acc-claude"])
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
    // Accounts follow the server's account kinds for the harness, the default first.
    #expect(catalog.accounts(for: .codex).map(\.id) == ["acc-default", "acc-codex"])
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
    #expect(draft.accountId == "acc-default")
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
    #expect(body["modelAccountId"] as? String == "acc-default" && body["repo"] as? String == "api")
    #expect(body["idleSeconds"] == nil && body["size"] == nil)
    // A golden without a saved snapshot cannot start an orchestrator.
    draft.goldenId = "g-draft"
    #expect(catalog.request(orgId: "org-a", draft: draft) == .failure(.goldenNotReady))
}

@Test func aServerWithoutPairsOffersNothingToCreate() async throws {
    let (client, _, _) = try await signedIn([(200, #"{"version":1,"enabled":false,"reason":"native_conformance_required"}"#), (200, goldens), (200, credentials)])
    let catalog = OrchestratorCreateCatalog(capabilities: try await client.orchestratorCapabilities(),
                                            goldens: try await client.goldens(), accounts: try await client.modelAccounts())
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
                                        operations: [("message", "uncertain", 3)], agentWorking: true)
    #expect(!settling.canMessage && !settling.canSteer && !settling.canStop)
    #expect(settling.open == .init(kind: "message", uncertain: true))
    #expect(settling.composerNote?.contains("settling") == true)
    // Create is asynchronous: never send before it has succeeded.
    let creating = OrchestratorControls(state: "creating", continuity: "not_started", blockedReason: nil, revision: 3,
                                        operations: [("create", "pending", 3)], agentWorking: false)
    #expect(creating.phase == .creating && !creating.canMessage && !creating.canRecover)
    let uncertainCreate = OrchestratorControls(state: "creating", continuity: "not_started", blockedReason: nil, revision: 3,
                                               operations: [("create", "uncertain", 3)], agentWorking: false)
    #expect(uncertainCreate.canRecover)
    let blocked = OrchestratorControls(state: "blocked", continuity: "unverified", blockedReason: "wait_cap_exhausted", revision: 3,
                                       operations: [], agentWorking: false)
    // Nothing to settle: the server would refuse recovery, so it is not offered.
    #expect(!blocked.canRecover && blocked.canStop && !blocked.canMessage)
    #expect(blocked.phase == .blocked(explanation: OrchestratorExplanation.text(for: "wait_cap_exhausted")))
    let blockedStop = OrchestratorControls(state: "blocked", continuity: "unverified", blockedReason: "native_stop_unconfirmed",
                                           revision: 3, operations: [("stop", "uncertain", 3)], agentWorking: false)
    #expect(blockedStop.canRecover && !blockedStop.canStop)
    let staleStop = OrchestratorControls(state: "blocked", continuity: "unverified", blockedReason: nil,
                                         revision: 4, operations: [("stop", "uncertain", 3)], agentWorking: false)
    #expect(!staleStop.canRecover)
    let stopped = OrchestratorControls(state: "stopped", continuity: "native", blockedReason: nil, revision: 3, operations: [], agentWorking: false)
    #expect(stopped.canResume && !stopped.canStop)
    let unverified = OrchestratorControls(state: "stopped", continuity: "unverified", blockedReason: nil, revision: 3, operations: [], agentWorking: false)
    #expect(!unverified.canResume && unverified.composerNote?.contains("could not verify") == true)
    let lost = OrchestratorControls(state: "ready", continuity: "lost", blockedReason: nil, revision: 3, operations: [], agentWorking: false)
    #expect(!lost.canMessage && lost.composerNote?.contains("lost") == true)
    let future = OrchestratorControls(state: "hibernating", continuity: "native", blockedReason: nil, revision: 3, operations: [], agentWorking: false)
    #expect(future.phase == .unknown("hibernating") && !future.canMessage && !future.canStop)
}

@Test func createProgressSettlesOnlyOnTheServersReceipt() {
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
    for code in ["conflict", "unavailable", "runtime_uncertain", "not_found", "invalid_request", "create_recovered_terminated", "stop_recovered_terminated", "native_state_lost"] {
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
