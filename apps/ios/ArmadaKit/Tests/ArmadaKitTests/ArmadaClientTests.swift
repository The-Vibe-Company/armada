import Foundation
import Testing
@testable import ArmadaKit

private final class MemoryStorage: SessionStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    func load() -> Data? { lock.withLock { data } }
    func save(_ value: Data) { lock.withLock { data = value } }
    func remove() { lock.withLock { data = nil } }
}
private actor ScriptedTransport: ArmadaTransport {
    struct Reply: Sendable { let status: Int; let body: String }
    private var replies: [Reply]
    private(set) var requests: [URLRequest] = []
    init(_ replies: [Reply]) { self.replies = replies }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        guard !replies.isEmpty else { throw URLError(.badServerResponse) }
        let next = replies.removeFirst()
        return (Data(next.body.utf8), HTTPURLResponse(url: request.url!, statusCode: next.status, httpVersion: nil, headerFields: nil)!)
    }
}
// Synthetic, non-authorizing values, never credentials from a running service.
private let login = #"{"accessToken":"fixture-access","refreshToken":"fixture-refresh","expiresAt":"2099-01-01T00:00:00Z"}"#

@Test func loginRestoreAndOrganizationAuthorization() async throws {
    let transport = ScriptedTransport([
        .init(status: 200, body: login),
        .init(status: 200, body: #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#),
        .init(status: 200, body: #"{"orgs":[]}"#)
    ])
    let storage = MemoryStorage()
    let client = try ArmadaClient(transport: transport, storage: storage)
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    let restored = try ArmadaClient(transport: transport, storage: storage)
    try await restored.restore()
    #expect(await restored.selectedOrgID == "org-a")
    await #expect(throws: ArmadaError.forbidden) { try await restored.selectOrganization("other") }
    let requests = await transport.requests
    #expect(requests[0].url?.path == "/api/v1/auth/email/verify")
    #expect(requests[0].value(forHTTPHeaderField: "Authorization") == nil)
    #expect(requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer fixture-access")
}

@Test func errorsNeverExposeServerBodyAndSignOutClearsPersistence() async throws {
    let transport = ScriptedTransport([.init(status: 200, body: login), .init(status: 503, body: "private server details")])
    let storage = MemoryStorage()
    let client = try ArmadaClient(transport: transport, storage: storage)
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    await #expect(throws: ArmadaError.unavailable) { try await client.signOut() }
    #expect(storage.load() == nil)
    await #expect(throws: ArmadaError.signedOut) { _ = try await client.organizations() }
}

@Test func invalidSessionResponseCannotBecomeAuthority() async throws {
    let client = try ArmadaClient(transport: ScriptedTransport([.init(status: 200, body: #"{"accessToken":"x"}"#)]), storage: MemoryStorage())
    await #expect(throws: ArmadaError.invalidResponse) { try await client.verifyEmail(email: "person@example.test", code: "123456") }
    await #expect(throws: ArmadaError.signedOut) { _ = try await client.organizations() }
}

@Test func originMustBeSecureAndRestoredSessionIsOriginBound() async throws {
    #expect(throws: ArmadaError.invalidOrigin) { try ArmadaClient(origin: URL(string: "http://example.test")!, storage: MemoryStorage()) }
    let storage = MemoryStorage()
    let client = try ArmadaClient(transport: ScriptedTransport([.init(status: 200, body: login)]), storage: storage)
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    let other = try ArmadaClient(origin: URL(string: "https://other.example.test")!, storage: storage)
    try await other.restore()
    await #expect(throws: ArmadaError.signedOut) { _ = try await other.organizations() }
}

private actor RefreshTransport: ArmadaTransport {
    private var release: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    private var refreshStarted = false
    private(set) var refreshCount = 0
    func waitForRefresh() async {
        if refreshStarted { return }
        await withCheckedContinuation { entered = $0 }
    }
    func completeRefresh() { release?.resume(); release = nil }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let body: String
        switch request.url!.lastPathComponent {
        case "verify": body = #"{"accessToken":"old-fixture","refreshToken":"old-refresh","expiresAt":"2000-01-01T00:00:00Z"}"#
        case "refresh":
            refreshCount += 1
            await withCheckedContinuation { continuation in
                release = continuation; refreshStarted = true; entered?.resume(); entered = nil
            }
            body = login
        case "logout": body = #"{"ok":true}"#
        default: body = #"{"orgs":[]}"#
        }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

@Test func concurrentExpiredRequestsShareRotation() async throws {
    let transport = RefreshTransport()
    let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    async let first = client.organizations()
    async let second = client.organizations()
    await transport.waitForRefresh()
    await transport.completeRefresh()
    _ = try await (first, second)
    #expect(await transport.refreshCount == 1)
}

@Test func signOutFencesInflightRefresh() async throws {
    let transport = RefreshTransport()
    let storage = MemoryStorage()
    let client = try ArmadaClient(transport: transport, storage: storage)
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    let request = Task { try await client.organizations() }
    await transport.waitForRefresh()
    try await client.signOut()
    await transport.completeRefresh()
    do { _ = try await request.value; Issue.record("Stale refresh restored signed-out authority") }
    catch { /* Cancellation is required; never silently restore old authority. */ }
    #expect(storage.load() == nil)
    await #expect(throws: ArmadaError.signedOut) { _ = try await client.organizations() }
}

@Test func metadataMissingPermissionHintsFailsClosedWithoutInteriorRequest() async throws {
    let row = #"{"id":"sandbox-a","orgId":"org-a","ownerId":"other","provider":"boat","providerSandboxId":"bx_display","boatId":"bx_display","harness":"codex","model":null,"reasoningEffort":null,"status":"ready","createdAt":"2026-11-09T00:00:00Z","stoppedAt":null,"expiresAt":null,"effectiveTtlSeconds":null,"machineSize":"small","displayLabel":"Sandbox sandbox-a"}"#
    let transport = ScriptedTransport([
        .init(status: 200, body: login),
        .init(status: 200, body: #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#),
        .init(status: 200, body: "{\"sandboxes\":[" + row + "],\"total\":1,\"page\":1,\"limit\":25,\"hasMore\":false,\"nextPage\":null}")
    ])
    let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    await #expect(throws: ArmadaError.invalidResponse) { _ = try await client.sandboxMetadata() }
    let paths = await transport.requests.map { $0.url!.path }
    #expect(paths == ["/api/v1/auth/email/verify", "/api/v1/org/list", "/api/v1/sandbox/list"])
}

@Test func selectingOrganizationSurvivesSessionRotation() async throws {
    let transport = ScriptedTransport([
        .init(status: 200, body: #"{"accessToken":"old-fixture","refreshToken":"old-refresh","expiresAt":"2000-01-01T00:00:00Z"}"#),
        .init(status: 200, body: login),
        .init(status: 200, body: #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#)
    ])
    let storage = MemoryStorage()
    let client = try ArmadaClient(transport: transport, storage: storage)
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    #expect(await client.selectedOrgID == "org-a")
    let restored = try ArmadaClient(transport: transport, storage: storage)
    try await restored.restore()
    #expect(await restored.selectedOrgID == "org-a")
}

@Test func uncertainCreateRetainsIdentityAcrossRejectedRetry() async throws {
    let configuration = OrchestratorCreate(orgId: "org-a", name: "Coordinator", goldenId: "golden-a",
        provider: .boat, harness: .codex, model: "model-a", modelAccountId: "account-a", size: .large)
    let transport = ScriptedTransport([
        .init(status: 200, body: login),
        .init(status: 200, body: #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#),
        .init(status: 200, body: #"{"version":1,"enabled":true}"#),
        .init(status: 503, body: #"{"error":{"code":"unavailable","message":"unavailable"}}"#),
        .init(status: 200, body: #"{"version":1,"enabled":true}"#),
        .init(status: 400, body: #"{"error":{"code":"invalid_request","message":"invalid_request"}}"#),
        .init(status: 200, body: #"{"version":1,"enabled":true}"#),
        .init(status: 202, body: #"{"version":1,"id":"operation-a","orchestratorId":"parent-a","kind":"create","state":"succeeded","revision":1,"errorCode":null}"#)
    ])
    let storage = MemoryStorage()
    let client = try ArmadaClient(transport: transport, storage: storage)
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    let command = try await client.prepareOrchestratorCreate(configuration)
    await #expect(throws: ArmadaError.unavailable) { _ = try await client.submitOrchestratorOperation(command.id) }
    await #expect(throws: ArmadaError.conflict) { _ = try await client.prepareOrchestratorCreate(configuration) }
    let restored = try ArmadaClient(transport: transport, storage: storage)
    try await restored.restore()
    #expect(await restored.pendingOperations.first?.state == .uncertain)
    await #expect(throws: ArmadaError.invalidRequest) { _ = try await restored.submitOrchestratorOperation(command.id) }
    await #expect(throws: ArmadaError.conflict) { try await restored.discardOrchestratorOperation(command.id) }
    #expect(await restored.pendingOperations.first?.state == .uncertain)
    let receipt = try await restored.submitOrchestratorOperation(command.id)
    #expect(receipt.id == "operation-a")
    let posts = await transport.requests.filter { $0.url!.path == "/api/v1/orchestrators" }
    #expect(posts.count == 3)
    let submitted = try JSONSerialization.jsonObject(with: posts[0].httpBody!) as! [String: Any]
    #expect(submitted["size"] as? String == "large")
    #expect(posts[0].httpBody == posts[1].httpBody)
    #expect(posts[0].httpBody == posts[2].httpBody)
    #expect(posts[0].value(forHTTPHeaderField: "Idempotency-Key") == posts[1].value(forHTTPHeaderField: "Idempotency-Key"))
    #expect(posts[0].value(forHTTPHeaderField: "Idempotency-Key") == posts[2].value(forHTTPHeaderField: "Idempotency-Key"))
    #expect(posts[0].value(forHTTPHeaderField: "Idempotency-Key") != nil)
}

@Test func disabledNativeCapabilityCannotSubmitOrAllocate() async throws {
    let transport = ScriptedTransport([
        .init(status: 200, body: login),
        .init(status: 200, body: #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#),
        .init(status: 200, body: #"{"version":1,"enabled":false,"reason":"native_conformance_required"}"#)
    ])
    let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    let command = try await client.prepareOrchestratorMutation(id: "parent-a", action: .resume, expectedRevision: 7)
    await #expect(throws: ArmadaError.unavailable) { _ = try await client.submitOrchestratorOperation(command.id) }
    #expect(await transport.requests.last?.url?.path == "/api/v1/orchestrators/capabilities")
    #expect(await transport.requests.count == 3)
    #expect(await client.pendingOperations.first?.state == .pending)
    // The actual capability refusal happened before mutation dispatch, so this
    // local command is provably unadmitted and can be cancelled without signout.
    #expect(await client.pendingOperations.first?.canDiscard == true)
    try await client.discardOrchestratorOperation(command.id)
    let next = try await client.prepareOrchestratorMutation(id: "parent-a", action: .stop, expectedRevision: 7)
    #expect(next.id != command.id)
    #expect(await transport.requests.count == 3)
}

@Test func eventCursorAndNativeMessageIdentitySurviveTransport() async throws {
    let page = #"{"version":1,"events":[{"id":"outer-2","orchestratorId":"parent-a","at":"2026-11-09T00:00:00Z","revision":7,"kind":"agent","event":{"id":"native-event-9","at":99,"conversationId":"conversation-native","promptId":"turn-native","kind":"message","text":"delta","partial":true,"messageId":"message-native","textMode":"delta","tools":[]}},{"id":"outer-1","orchestratorId":"parent-a","at":"2026-11-09T00:00:01Z","revision":7,"kind":"state","state":"ready","continuity":"native"}],"cursor":"opaque+/=?&next","hasMore":true}"#
    let transport = ScriptedTransport([
        .init(status: 200, body: login),
        .init(status: 200, body: #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#),
        .init(status: 200, body: page)
    ])
    let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    let result = try await client.orchestratorEvents(id: "parent-a", cursor: "opaque+/=?&prior")
    #expect(result.events.map(\.id) == ["outer-2", "outer-1"])
    #expect(result.cursor == "opaque+/=?&next")
    guard case .agent(let event) = result.events[0].body,
          case .message(_, _, let messageId, let mode, _, _) = event.body else {
        Issue.record("Typed native message was lost"); return
    }
    #expect(event.conversationId == "conversation-native")
    #expect(messageId == "message-native")
    #expect(mode == "delta")
    let url = await transport.requests.last!.url!
    #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "cursor" })?.value == "opaque+/=?&prior")
}

@Test func structuredInitialRejectionAllowsExplicitRepair() async throws {
    let transport = ScriptedTransport([
        .init(status: 200, body: login),
        .init(status: 200, body: #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#),
        .init(status: 200, body: #"{"version":1,"enabled":true}"#),
        .init(status: 400, body: #"{"error":{"code":"invalid_request","message":"invalid_request"}}"#)
    ])
    let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    let bad = OrchestratorCreate(orgId: "org-a", name: "", goldenId: "golden-a", provider: .boat,
        harness: .codex, model: "model-a", modelAccountId: "account-a")
    let command = try await client.prepareOrchestratorCreate(bad)
    #expect(await client.pendingOperations.first?.canDiscard == true)
    await #expect(throws: ArmadaError.invalidRequest) { _ = try await client.submitOrchestratorOperation(command.id) }
    #expect(await client.pendingOperations.first?.state == .failed)
    #expect(await client.pendingOperations.first?.canDiscard == true)
    #expect(await client.pendingOperations.first?.rejectedBeforeAdmission == true)
    try await client.discardOrchestratorOperation(command.id)
    let repaired = OrchestratorCreate(orgId: "org-a", name: "Repaired", goldenId: "golden-a", provider: .boat,
        harness: .codex, model: "model-a", modelAccountId: "account-a")
    #expect(try await client.prepareOrchestratorCreate(repaired).id != command.id)
}

private actor SubmissionRaceTransport: ArmadaTransport {
    private let firstMutationSucceeds: Bool
    private let gateMutations: Bool
    private let laterMutationStatus: Int
    init(firstMutationSucceeds: Bool = true, gateMutations: Bool = false, laterMutationStatus: Int = 400) {
        self.firstMutationSucceeds = firstMutationSucceeds
        self.gateMutations = gateMutations
        self.laterMutationStatus = laterMutationStatus
    }
    private var mutationReleases: [Int: CheckedContinuation<Void, Never>] = [:]
    private var mutationEntered: [Int: CheckedContinuation<Void, Never>] = [:]
    private(set) var mutationRequests: [URLRequest] = []
    func waitForMutation(_ index: Int) async {
        if mutationReleases[index] != nil { return }
        await withCheckedContinuation { mutationEntered[index] = $0 }
    }
    func releaseMutation(_ index: Int) { mutationReleases.removeValue(forKey: index)?.resume() }
    private var capabilityCount = 0
    private var releases: [Int: CheckedContinuation<Void, Never>] = [:]
    private var entered: [Int: CheckedContinuation<Void, Never>] = [:]
    private(set) var mutationCount = 0
    func waitForCapability(_ index: Int) async {
        if releases[index] != nil { return }
        await withCheckedContinuation { entered[index] = $0 }
    }
    func releaseCapability(_ index: Int) { releases.removeValue(forKey: index)?.resume() }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let body: String
        var status = 200
        switch request.url!.lastPathComponent {
        case "verify": body = login
        case "list": body = #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#
        case "capabilities":
            capabilityCount += 1
            let index = capabilityCount
            await withCheckedContinuation { continuation in
                releases[index] = continuation; entered.removeValue(forKey: index)?.resume()
            }
            body = #"{"version":1,"enabled":true}"#
        default:
            mutationCount += 1
            let mutation = mutationCount
            mutationRequests.append(request)
            if gateMutations {
                await withCheckedContinuation { continuation in
                    mutationReleases[mutation] = continuation
                    mutationEntered.removeValue(forKey: mutation)?.resume()
                }
            }
            if mutation == 1, firstMutationSucceeds {
                status = 202
                body = #"{"version":1,"id":"operation-a","orchestratorId":"parent-a","kind":"stop","state":"succeeded","revision":8,"errorCode":null}"#
            } else {
                status = mutation == 1 ? 503 : laterMutationStatus
                if status == 503 { body = #"{"error":{"code":"unavailable","message":"unavailable"}}"# }
                else if status == 409 { body = #"{"error":{"code":"conflict","message":"conflict"}}"# }
                else { body = #"{"error":{"code":"invalid_request","message":"invalid_request"}}"# }
            }
        }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

@Test func delayedSubmitCannotEraseKnownTerminalReceipt() async throws {
    let transport = SubmissionRaceTransport()
    let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    let command = try await client.prepareOrchestratorMutation(id: "parent-a", action: .stop, expectedRevision: 7)
    let first = Task { try await client.submitOrchestratorOperation(command.id) }
    await transport.waitForCapability(1)
    let second = Task { try await client.submitOrchestratorOperation(command.id) }
    await transport.waitForCapability(2)
    await transport.releaseCapability(1)
    #expect(try await first.value.state == .succeeded)
    await transport.releaseCapability(2)
    #expect(try await second.value.state == .succeeded)
    #expect(await transport.mutationCount == 1)
    #expect(await client.pendingOperations.first?.state == .succeeded)
}

@Test func concurrentRejectedRetryCannotMakeEarlierUnknownEffectDiscardable() async throws {
    let transport = SubmissionRaceTransport(firstMutationSucceeds: false)
    let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    let command = try await client.prepareOrchestratorMutation(id: "parent-a", action: .stop, expectedRevision: 7)
    let first = Task { try await client.submitOrchestratorOperation(command.id) }
    await transport.waitForCapability(1)
    let second = Task { try await client.submitOrchestratorOperation(command.id) }
    await transport.waitForCapability(2)
    await transport.releaseCapability(1)
    await #expect(throws: ArmadaError.unavailable) { _ = try await first.value }
    await transport.releaseCapability(2)
    await #expect(throws: ArmadaError.invalidRequest) { _ = try await second.value }
    #expect(await client.pendingOperations.first?.state == .uncertain)
    await #expect(throws: ArmadaError.conflict) { try await client.discardOrchestratorOperation(command.id) }
}

@Test func canonicalSizeWireValuesAndOmissionMatchPublishedCreateContract() throws {
    // Independent backend wire contract: no native shape or "default" sentinel.
    for raw in ["small", "medium", "large", "xlarge"] {
        let size = try JSONDecoder().decode(MachineSize.self, from: JSONEncoder().encode(raw))
        let configuration = OrchestratorCreate(orgId: "org-a", name: "Coordinator", goldenId: "golden-a",
            provider: .boat, harness: .codex, model: "model-a", modelAccountId: "account-a", size: size)
        let submitted = try JSONSerialization.jsonObject(with: JSONEncoder().encode(configuration)) as! [String: Any]
        #expect(submitted["size"] as? String == raw)
    }
    let inherited = OrchestratorCreate(orgId: "org-a", name: "Coordinator", goldenId: "golden-a",
        provider: .boat, harness: .codex, model: "model-a", modelAccountId: "account-a")
    let submitted = try JSONSerialization.jsonObject(with: JSONEncoder().encode(inherited)) as! [String: Any]
    #expect(submitted["size"] == nil)
    #expect(submitted["repo"] == nil)
    #expect(throws: (any Error).self) {
        _ = try JSONDecoder().decode(MachineSize.self, from: Data(#""default""#.utf8))
    }
}

@Test func bareValidationStatusAndGenericConflictNeverProveNoAdmission() async throws {
    // Actual662 uses the same409 conflict even when both post-effect receipt
    // publications fail. A proxy400 also carries no producer admission evidence.
    for (status, body, expected) in [
        (400, "proxy validation error", ArmadaError.http(400)),
        (409, #"{"error":{"code":"conflict","message":"conflict"}}"#, ArmadaError.conflict)
    ] {
        let transport = ScriptedTransport([
            .init(status: 200, body: login),
            .init(status: 200, body: #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#),
            .init(status: 200, body: #"{"version":1,"enabled":true}"#),
            .init(status: status, body: body)
        ])
        let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
        try await client.verifyEmail(email: "person@example.test", code: "123456")
        try await client.selectOrganization("org-a")
        let command = try await client.prepareOrchestratorMutation(id: "parent-a", action: .stop, expectedRevision: 7)
        await #expect(throws: expected) { _ = try await client.submitOrchestratorOperation(command.id) }
        #expect(await client.pendingOperations.first?.state == .uncertain)
        #expect(await client.pendingOperations.first?.canDiscard == false)
        await #expect(throws: ArmadaError.conflict) { try await client.discardOrchestratorOperation(command.id) }
        await #expect(throws: ArmadaError.conflict) {
            _ = try await client.prepareOrchestratorMutation(id: "parent-a", action: .stop, expectedRevision: 8)
        }
    }
}

@Test func futureEventKindsPreservePageCursorAndKnownNeighbors() async throws {
    // Existing producer envelope/AgentEvent base with additive future kind variants.
    let page = #"{"version":1,"events":[{"id":"future-outer","orchestratorId":"parent-a","at":"2026-11-09T00:00:00Z","revision":7,"kind":"future-progress","progress":{"done":3}},{"id":"future-agent","orchestratorId":"parent-a","at":"2026-11-09T00:00:00Z","revision":7,"kind":"agent","event":{"id":"native-future","at":99,"kind":"future-audio","sample":"opaque"}},{"id":"known","orchestratorId":"parent-a","at":"2026-11-09T00:00:01Z","revision":7,"kind":"state","state":"ready","continuity":"native"}],"cursor":"opaque+/=?&after-future","hasMore":true}"#
    let transport = ScriptedTransport([
        .init(status: 200, body: login),
        .init(status: 200, body: #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#),
        .init(status: 200, body: page)
    ])
    let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    let result = try await client.orchestratorEvents(id: "parent-a")
    #expect(result.events.map(\.id) == ["future-outer", "future-agent", "known"])
    #expect(result.cursor == "opaque+/=?&after-future")
    #expect(result.hasMore)
    guard case .unknown(let kind, let payload) = result.events[0].body,
          case .agent(let agent) = result.events[1].body,
          case .unknown(let agentKind, let agentPayload) = agent.body,
          case .state(.ready, .native) = result.events[2].body else {
        Issue.record("Future kinds dropped the page or known neighbor"); return
    }
    #expect(kind == "future-progress")
    guard case .object(let fields) = payload, case .object(let agentFields) = agentPayload else {
        Issue.record("Unknown event bytes were not preserved as JSON"); return
    }
    #expect(fields["progress"] == .object(["done": .number(3)]))
    #expect(agentKind == "future-audio")
    #expect(agentFields["sample"] == .string("opaque"))
    // A known state event missing mandatory continuity is not a future variant.
    let malformed = #"{"version":1,"events":[{"id":"bad","orchestratorId":"parent-a","at":"2026-11-09T00:00:00Z","revision":7,"kind":"state","state":"ready"}],"cursor":"must-not-accept","hasMore":false}"#
    #expect(throws: (any Error).self) {
        _ = try JSONDecoder().decode(OrchestratorEventPage.self, from: Data(malformed.utf8))
    }
}

@Test func concurrentPostFailureReturnsAlreadyKnownTerminalReceipt() async throws {
    let transport = SubmissionRaceTransport(gateMutations: true, laterMutationStatus: 409)
    let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    let command = try await client.prepareOrchestratorMutation(id: "parent-a", action: .stop, expectedRevision: 7)
    let first = Task { try await client.submitOrchestratorOperation(command.id) }
    await transport.waitForCapability(1)
    await transport.releaseCapability(1)
    await transport.waitForMutation(1)
    let second = Task { try await client.submitOrchestratorOperation(command.id) }
    await transport.waitForCapability(2)
    await transport.releaseCapability(2)
    await transport.waitForMutation(2)
    // Both actual POSTs are in flight. One authoritative success arrives before
    // the other generic409; cleanup permission must never turn it into rejection.
    await transport.releaseMutation(1)
    let receipt = try await first.value
    #expect(receipt.state == .succeeded)
    await transport.releaseMutation(2)
    #expect(try await second.value.id == receipt.id)
    #expect(await client.pendingOperations.first?.receipt?.state == .succeeded)
    #expect(await client.pendingOperations.first?.rejectedBeforeAdmission == false)
    let requests = await transport.mutationRequests
    #expect(requests.count == 2)
    #expect(requests[0].httpBody == requests[1].httpBody)
    #expect(requests[0].value(forHTTPHeaderField: "Idempotency-Key") == requests[1].value(forHTTPHeaderField: "Idempotency-Key"))
}

// Owns durable cleanup behavior, not the private pruning algorithm: continued
// commands must retain a bounded recent history without evicting unknown effects.
@Test func terminalHistoryIsBoundedAcrossRestoreWithoutEvictingUncertainWork() async throws {
    var replies: [ScriptedTransport.Reply] = [
        .init(status: 200, body: login),
        .init(status: 200, body: #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#),
        .init(status: 200, body: #"{"version":1,"enabled":true}"#),
        .init(status: 409, body: #"{"error":{"code":"conflict","message":"conflict"}}"#)
    ]
    for index in 0..<40 {
        replies.append(.init(status: 200, body: #"{"version":1,"enabled":true}"#))
        replies.append(.init(status: 200, body: """
            {"version":1,"id":"receipt-\(index)","orchestratorId":"parent-b","kind":"message","state":"succeeded","revision":\(index + 1)}
            """))
    }
    let transport = ScriptedTransport(replies)
    let storage = MemoryStorage()
    let client = try ArmadaClient(transport: transport, storage: storage)
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    let unknown = try await client.prepareOrchestratorMutation(id: "parent-a", action: .stop, expectedRevision: 7)
    await #expect(throws: ArmadaError.conflict) { _ = try await client.submitOrchestratorOperation(unknown.id) }
    for index in 0..<40 {
        let command = try await client.prepareOrchestratorMutation(id: "parent-b", action: .message, expectedRevision: index, text: "message-\(index)")
        _ = try await client.submitOrchestratorOperation(command.id)
    }
    let restored = try ArmadaClient(transport: transport, storage: storage)
    try await restored.restore()
    let saved = await restored.pendingOperations
    #expect(saved.count == 33)
    #expect(saved.first?.id == unknown.id)
    #expect(saved.first?.state == .uncertain)
    #expect(saved.first?.body == unknown.body)
    #expect(saved.first?.key == unknown.key)
    #expect(saved.compactMap { $0.receipt?.id } == (8..<40).map { "receipt-\($0)" })
    // Pruned payloads are absent from the persisted Keychain blob, not just UI state.
    let stored = String(data: try #require(storage.load()), encoding: .utf8)!
    #expect(!stored.contains("receipt-0"))
}

@Test func explicitUncertainDiscardRequiresAcknowledgementAndUnlocksWithoutSigningOut() async throws {
    let transport = ScriptedTransport([
        .init(status: 200, body: login),
        .init(status: 200, body: #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#),
        .init(status: 200, body: #"{"version":1,"enabled":true}"#),
        .init(status: 409, body: #"{"error":{"code":"conflict","message":"conflict"}}"#)
    ])
    let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    let command = try await client.prepareOrchestratorMutation(id: "parent-a", action: .stop, expectedRevision: 7)
    await #expect(throws: ArmadaError.conflict) { _ = try await client.submitOrchestratorOperation(command.id) }
    #expect(try await client.reconcileOrchestratorOperation(command.id) == nil)
    #expect(await transport.requests.count == 4) // No guessed GET or rePOST when receipt ID was lost.
    await #expect(throws: ArmadaError.conflict) {
        try await client.discardUncertainOrchestratorOperation(command.id, acknowledgingPossibleEffects: false)
    }
    #expect(await client.pendingOperations.first?.key == command.key)
    try await client.discardUncertainOrchestratorOperation(command.id, acknowledgingPossibleEffects: true)
    #expect(await client.isSignedIn)
    let replacement = try await client.prepareOrchestratorMutation(id: "parent-a", action: .stop, expectedRevision: 8)
    #expect(replacement.key != command.key)
    #expect(await transport.requests.count == 4) // Explicit local abandon never cancels or auto-resends.
}

// Actual owner detail/operation envelopes: only an exact receipt ID, parent,
// action and revision can settle saved work; absence and unrelated operations do not.
@Test func readOnlyReceiptReconciliationUsesExactCorrelationAndNoMutation() async throws {
    let configuration = #"{"version":1,"orgId":"org-a","name":"Coordinator","goldenId":"golden-a","provider":"boat","harness":"codex","model":"model-a","modelAccountId":"account-a","idleSeconds":1800,"maxActiveChildren":4}"#
    func detail(_ operation: String) -> String {
        """
        {"version":1,"orchestrator":{"version":1,"id":"parent-a","ownerId":"owner-a","configuration":\(configuration),"state":"ready","revision":8,"continuity":"native","createdAt":"2026-11-09T00:00:00Z","updatedAt":"2026-11-09T00:00:00Z","lastActivityAt":"2026-11-09T00:00:00Z","skillRevision":"v1"},"operations":[\(operation)],"waits":[],"childSandboxIds":[]}
        """
    }
    func receipt(id: String = "receipt-a", parent: String = "parent-a", kind: String = "stop", revision: Int = 8, state: String = "succeeded") -> String {
        """
        {"version":1,"id":"\(id)","orchestratorId":"\(parent)","kind":"\(kind)","state":"\(state)","revision":\(revision)}
        """
    }
    let transport = ScriptedTransport([
        .init(status: 200, body: login),
        .init(status: 200, body: #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#),
        .init(status: 200, body: #"{"version":1,"enabled":true}"#),
        .init(status: 202, body: receipt(state: "uncertain")),
        .init(status: 200, body: detail("")),
        .init(status: 200, body: detail(receipt(id: "unrelated"))),
        .init(status: 200, body: detail(receipt(parent: "other-parent"))),
        .init(status: 200, body: detail(receipt(kind: "resume"))),
        .init(status: 200, body: detail(receipt(revision: 9))),
        .init(status: 200, body: detail(receipt(state: "pending"))),
        .init(status: 200, body: detail(receipt()))
    ])
    let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    let command = try await client.prepareOrchestratorMutation(id: "parent-a", action: .stop, expectedRevision: 7)
    #expect(try await client.submitOrchestratorOperation(command.id).state == .uncertain)
    for _ in 0..<5 {
        #expect(try await client.reconcileOrchestratorOperation(command.id) == nil)
        #expect(await client.pendingOperations.first?.state == .uncertain)
    }
    #expect(try await client.reconcileOrchestratorOperation(command.id)?.state == .pending)
    #expect(await client.pendingOperations.first?.canDiscard == false)
    #expect(try await client.reconcileOrchestratorOperation(command.id)?.state == .succeeded)
    #expect(await client.pendingOperations.first?.canDiscard == true)
    let requests = await transport.requests
    #expect(requests.filter { $0.httpMethod == "POST" && $0.url?.path.contains("/stop") == true }.count == 1)
    #expect(requests.suffix(7).allSatisfy { $0.httpMethod == "GET" && $0.url?.path == "/api/v1/orchestrators/parent-a" })
}
