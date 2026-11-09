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

@Test func uncertainMutationRestoresExactKeyRevisionAndBytes() async throws {
    let configuration = OrchestratorCreate(orgId: "org-a", name: "Coordinator", goldenId: "golden-a",
        provider: .boat, harness: .codex, model: "model-a", modelAccountId: "account-a")
    let transport = ScriptedTransport([
        .init(status: 200, body: login),
        .init(status: 200, body: #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#),
        .init(status: 200, body: #"{"version":1,"enabled":true}"#),
        .init(status: 503, body: #"{"error":{"code":"unavailable","message":"unavailable"}}"#),
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
    let receipt = try await restored.submitOrchestratorOperation(command.id)
    #expect(receipt.id == "operation-a")
    let posts = await transport.requests.filter { $0.url!.path == "/api/v1/orchestrators" }
    #expect(posts.count == 2)
    #expect(posts[0].httpBody == posts[1].httpBody)
    #expect(posts[0].value(forHTTPHeaderField: "Idempotency-Key") == posts[1].value(forHTTPHeaderField: "Idempotency-Key"))
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
