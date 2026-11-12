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

@Test func emailCodeRefusalExplainsSingleUseWithoutExposingProviderBody() async throws {
    let client = try ArmadaClient(transport: ScriptedTransport([
        .init(status: 401, body: "private provider details")
    ]), storage: MemoryStorage())
    await #expect(throws: ArmadaError.emailCodeRefused) {
        try await client.verifyEmail(email: "person@example.test", code: "123456")
    }
    #expect(ArmadaError.emailCodeRefused.localizedDescription.contains("already used"))
    await #expect(throws: ArmadaError.signedOut) { _ = try await client.organizations() }
}

@Test func restoringAnOlderSessionIgnoresTheRetiredCommandJournal() async throws {
    let storage = MemoryStorage()
    // Retired payloads need not be understood to retain the person's login and organization.
    let stored = #"{"origin":"https://armada.thevibecompany.co","session":\#(login),"selectedOrgID":"org-a","operations":[{"retiredCommandFormat":"not-decoded"}],"sandboxPrompts":[{"id":"00000000-0000-4000-8000-000000000001","sandboxID":"00000000-0000-4000-8000-000000000002","orgID":"org-a","text":"Unconfirmed before upgrade","sentAt":0}]}"#
    storage.save(Data(stored.utf8))
    let transport = ScriptedTransport([])
    let client = try ArmadaClient(transport: transport, storage: storage)
    try await client.restore()
    #expect(await client.isSignedIn)
    #expect(await client.selectedOrgID == "org-a")
    #expect(await transport.requests.isEmpty)
    let retained = try #require(storage.load())
    let data = try #require(JSONSerialization.jsonObject(with: retained) as? [String: Any])
    #expect(data["operations"] == nil)
    let pending = await client.pendingSandboxPrompts
    #expect(pending.count == 1)
    #expect(pending.first?.text == "Unconfirmed before upgrade")
    let restoredAgain = try ArmadaClient(transport: transport, storage: storage)
    try await restoredAgain.restore()
    #expect(await restoredAgain.pendingSandboxPrompts == pending)
    #expect(await transport.requests.isEmpty)
}

@Test func emailRequestShowsTheServersSpecificRateLimitRemedy() async throws {
    let client = try ArmadaClient(transport: ScriptedTransport([
        .init(status: 429, body: #"{"error":{"code":"rate_limited","message":"Wait 60 seconds before requesting another code."}}"#)
    ]), storage: MemoryStorage())
    do {
        try await client.startEmailLogin(email: "person@example.test")
        Issue.record("Expected a refusal")
    } catch {
        #expect(error.localizedDescription == "Wait 60 seconds before requesting another code.")
    }
}

@Test func structuredReadErrorsKeepCategoryAndBoundedExplanation() async throws {
    for (status, code, message, expected, cause) in [
        (403, "forbidden", "Only the sandbox owner can open it.", "Only the sandbox owner can open it.", ArmadaError.forbidden),
        (409, "conflict", "Wait\nfor setup.", "Wait for setup.", .conflict),
        (503, "dependency_unavailable", "Authentication is restarting.", "Authentication is restarting.", .unavailable),
        (400, "invalid", String(repeating: "a", count: 350), String(repeating: "a", count: 299) + "…", .http(400)),
    ] {
        let body = String(decoding: try JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": message]]), as: UTF8.self)
        let transport = ScriptedTransport([.init(status: 200, body: login), .init(status: status, body: body)])
        let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
        try await client.verifyEmail(email: "person@example.test", code: "123456")
        do { _ = try await client.organizations(); Issue.record("Expected failure") }
        catch {
            #expect(ArmadaServerFailure.underlying(error) == cause)
            #expect(error.localizedDescription == expected)
        }
    }
}

@Test func unsafeOrAbsentServerDetailKeepsExistingFallbackAndAuthenticated401SignsOut() async throws {
    for (status, body, cause) in [
        (400, "upstream non-JSON body", ArmadaError.http(400)),
        (400, #"{"error":{"code":"invalid","message":" \n\t "}}"#, .http(400)),
        (400, #"{"error":{"code":"invalid","message":"invalid"}}"#, .http(400)),
        (500, #"{"error":{"code":"unknown","message":"raw provider output"}}"#, .unavailable),
        (401, #"{"error":{"code":"unauthorized","message":"Expired server session."}}"#, .signedOut),
    ] {
        let transport = ScriptedTransport([.init(status: 200, body: login), .init(status: status, body: body)])
        let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
        try await client.verifyEmail(email: "person@example.test", code: "123456")
        await #expect(throws: cause) { _ = try await client.organizations() }
    }
}

@Test func idleSteerIsDistinctFromOtherConflictsWithoutAutomaticRetry() async throws {
    for (status, body, cause) in [
        (409, #"{"error":{"code":"no_running_turn","message":"No turn is running."}}"#, ArmadaError.noRunningTurn),
        (409, #"{"error":{"code":"no_running_turn"}}"#, .noRunningTurn),
        (409, #"{"error":{"code":"sandbox_not_ready","message":"Still starting."}}"#, .conflict),
        (409, #"{"error":{"code":"conflict","message":"State changed."}}"#, .conflict),
        (409, "not JSON", .conflict),
        (503, #"{"error":{"code":"no_running_turn","message":"Untrusted outage."}}"#, .unavailable),
    ] {
        let transport = ScriptedTransport([.init(status: 200, body: login), .init(status: status, body: body)])
        let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
        try await client.verifyEmail(email: "person@example.test", code: "123456")
        do {
            let _: OK = try await client.post("sandbox/steer", Empty())
            Issue.record("Expected steer refusal")
        } catch {
            #expect(ArmadaServerFailure.underlying(error) == cause)
            if cause == .noRunningTurn {
                #expect(SandboxMutationFailure.classify(error) == .refused)
            }
        }
        #expect(await transport.requests.count == 2)
    }
}
