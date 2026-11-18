import Foundation
import Testing
@testable import ArmadaKit

private final class MemoryStorage: SessionStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    init(data: Data? = nil) { self.data = data }
    private var failingWrites = false
    func failWrites() { lock.withLock { failingWrites = true } }
    func load() -> Data? { lock.withLock { data } }
    func save(_ value: Data) throws { try lock.withLock {
        if failingWrites { throw ArmadaError.secureStorage }
        data = value
    } }
    func remove() { lock.withLock { data = nil } }
}
private actor ScriptedTransport: ArmadaTransport {
    struct Reply: Sendable { let status: Int; let body: String }
    private var replies: [Reply]
    private let storage: MemoryStorage?
    private(set) var storageAtSend: Data?
    private(set) var requests: [URLRequest] = []
    init(_ replies: [Reply], storage: MemoryStorage? = nil) { self.replies = replies; self.storage = storage }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        if request.url?.path == "/api/v1/sandbox/send" { storageAtSend = storage?.load() }
        guard !replies.isEmpty else { throw URLError(.notConnectedToInternet) }
        let next = replies.removeFirst()
        return (Data(next.body.utf8), HTTPURLResponse(url: request.url!, statusCode: next.status, httpVersion: nil, headerFields: nil)!)
    }
}
// Synthetic, non-authorizing values, never credentials from a running service.
private let login = #"{"accessToken":"fixture-access","refreshToken":"fixture-refresh","expiresAt":"2099-01-01T00:00:00Z"}"#
private let orgs = #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#
private let sandboxID = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b"

private func signedIn(_ replies: [ScriptedTransport.Reply]) async throws -> (ArmadaClient, ScriptedTransport) {
    let transport = ScriptedTransport([.init(status: 200, body: login), .init(status: 200, body: orgs)] + replies)
    let client = try ArmadaClient(transport: transport, storage: MemoryStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    return (client, transport)
}

private func body(_ request: URLRequest) throws -> [String: String] {
    try JSONDecoder().decode([String: String].self, from: request.httpBody ?? Data())
}

private func detail(status: String, settled: Bool, prompt: String? = nil) -> String {
    let turn = prompt.map { #"{"promptId":"pr_1","conversationId":"c_1","state":"\#($0)","reason":null}"# } ?? "null"
    return #"{"id":"\#(sandboxID)","golden":"web","visibility":"org","harness":"claude","repositoryDir":null,"model":"opus","reasoningEffort":"high","machineSize":null,"status":"\#(status)","statusReason":null,"provider":"modal","providerState":"ready","conversationIds":["c_1"],"expiresAt":null,"prompt":\#(turn),"settled":\#(settled)}"#
}

@Test func conversationReadsUseTheCliRoutesWithTheSelectedOrganizationAndOpaqueCursor() async throws {
    let page = #"{"events":[{"id":"e1","at":1762646400000,"kind":"prompt","text":"Fix CI","status":"running","conversationId":"c_1","promptId":"pr_1"},{"id":"e2","at":1762646401000,"kind":"other","type":"native.unknown"}],"cursor":"opaque/+cursor=","hasMore":true,"settled":true}"#
    let (client, transport) = try await signedIn([
        .init(status: 200, body: detail(status: "running", settled: false, prompt: "running")),
        .init(status: 200, body: page),
        .init(status: 200, body: #"{"events":[],"cursor":"opaque/+cursor=","hasMore":false,"settled":true}"#)
    ])
    let read = try await client.sandboxDetail(id: sandboxID)
    #expect(read.prompt?.state == "running")
    #expect(read.isWorking)
    let first = try await client.sandboxEvents(id: sandboxID)
    #expect(first.events.map(\.id) == ["e1", "e2"])
    #expect(first.hasMore)
    // A future `other` event without data keeps the page and its cursor.
    if case .other(let type, let data) = first.events[1].body { #expect(type == "native.unknown"); #expect(data == .null) }
    else { Issue.record("Expected an other event") }
    _ = try await client.sandboxEvents(id: sandboxID, cursor: first.cursor)

    let requests = Array(await transport.requests.dropFirst(2))
    #expect(requests.map { $0.url!.path } == ["/api/v1/sandbox/detail", "/api/v1/logs/read", "/api/v1/logs/read"])
    #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-access" })
    #expect(try body(requests[0]) == ["id": sandboxID, "org": "org-a"])
    #expect(try body(requests[1]) == ["id": sandboxID, "org": "org-a"])
    #expect(try body(requests[2]) == ["id": sandboxID, "org": "org-a", "cursor": "opaque/+cursor="])
}

@Test func interiorRefusalIsReportedAndNeverInferredClientSide() async throws {
    let (client, transport) = try await signedIn([
        .init(status: 403, body: #"{"error":{"code":"forbidden","message":"private detail"}}"#),
        .init(status: 404, body: #"{"error":{"code":"not_found","message":"No such sandbox."}}"#)
    ])
    await #expect(throws: ArmadaServerFailure(cause: .forbidden, explanation: "private detail")) { _ = try await client.sandboxDetail(id: sandboxID) }
    await #expect(throws: ArmadaServerFailure(cause: .http(404), explanation: "No such sandbox.")) { _ = try await client.sandboxEvents(id: sandboxID) }
    // A malformed id is refused before any request leaves the device.
    await #expect(throws: ArmadaError.invalidRequest) { _ = try await client.sandboxDetail(id: "../outside") }
    #expect(await transport.requests.count == 4)
}

@Test func sendIsSentOnceAndAnAmbiguousFailureIsUnconfirmedNotRetried() async throws {
    let (client, transport) = try await signedIn([
        .init(status: 200, body: #"{"id":"\#(sandboxID)","promptId":"pr_2","conversationId":"c_1","status":"running"}"#),
        .init(status: 502, body: "upstream details"),
        // The provider accepted the prompt but its receipt was malformed: still a 400.
        .init(status: 400, body: #"{"error":{"code":"unknown","message":"unexpected answer"}}"#),
        .init(status: 400, body: #"{"error":{"code":"sandbox_not_ready","message":"not ready"}}"#),
        .init(status: 400, body: #"{"error":{"code":"missing_credential","message":"no key"}}"#),
        .init(status: 409, body: #"{"error":{"code":"conflict","message":"deleted"}}"#),
        .init(status: 200, body: #"{"id":"\#(sandboxID)","status":"stopping"}"#)
    ])
    let receipt = try await client.sendSandboxPrompt(id: sandboxID, text: "Add tests")
    #expect(receipt.promptId == "pr_2")
    do { _ = try await client.sendSandboxPrompt(id: sandboxID, text: "Again"); Issue.record("Expected a failure") }
    catch { #expect(SandboxMutationFailure.classify(error) == .unconfirmed) }
    let unconfirmed = try #require(await client.unconfirmedSandboxPrompt(id: sandboxID))
    // A person checked the transcript and explicitly dismissed this unknown outcome.
    try await client.dismissSandboxPrompt(id: unconfirmed.id)
    do { _ = try await client.sendSandboxPrompt(id: sandboxID, text: "Unknown"); Issue.record("Expected a failure") }
    catch { #expect(SandboxMutationFailure.classify(error) == .unconfirmed) }
    // A person checked the transcript and explicitly dismissed this unknown outcome.
    try await client.dismissSandboxPrompt(id: try #require(await client.unconfirmedSandboxPrompt(id: sandboxID)).id)
    do { _ = try await client.sendSandboxPrompt(id: sandboxID, text: "Early"); Issue.record("Expected a refusal") }
    catch { #expect(SandboxMutationFailure.classify(error) == .refused) }
    do { _ = try await client.sendSandboxPrompt(id: sandboxID, text: "No key"); Issue.record("Expected a refusal") }
    catch { #expect(SandboxMutationFailure.classify(error) == .refused) }
    do { _ = try await client.sendSandboxPrompt(id: sandboxID, text: "Later"); Issue.record("Expected a refusal") }
    catch { #expect(SandboxMutationFailure.classify(error) == .refused) }
    await #expect(throws: ArmadaError.invalidRequest) { _ = try await client.sendSandboxPrompt(id: sandboxID, text: "  \n") }
    #expect(try await client.stopSandbox(id: sandboxID).status == "stopping")

    let requests = Array(await transport.requests.dropFirst(2))
    #expect(requests.map { $0.url!.path } == Array(repeating: "/api/v1/sandbox/send", count: 6) + ["/api/v1/sandbox/stop"])
    #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Idempotency-Key") == nil })
    // Each send carries its pending prompt's UUID as a lowercase request_id, so a Docker sandbox can deduplicate it.
    let first = try body(requests[0])
    let firstKey = try #require(first["request_id"])
    #expect(UUID(uuidString: firstKey) != nil && firstKey == firstKey.lowercased())
    #expect(first == ["id": sandboxID, "org": "org-a", "prompt": "Add tests", "request_id": firstKey])
    #expect(try body(requests[1])["request_id"] == unconfirmed.id.uuidString.lowercased())
    #expect(Set(try requests.prefix(6).map { try body($0)["request_id"] }).count == 6)
    #expect(try body(requests[6]) == ["id": sandboxID, "org": "org-a"])
}

@Test func mutationFailuresClassifyConservatively() {
    #expect(SandboxMutationFailure.classify(ArmadaError.signedOut) == .signedOut)
    #expect(SandboxMutationFailure.classify(ArmadaError.forbidden) == .noAccess)
    #expect(SandboxMutationFailure.classify(ArmadaError.http(404)) == .noAccess)
    #expect(SandboxMutationFailure.classify(ArmadaError.invalidRequest) == .refused)
    #expect(SandboxMutationFailure.classify(ArmadaError.http(400)) == .unconfirmed)
    #expect(SandboxMutationFailure.classify(ArmadaError.conflict) == .refused)
    #expect(SandboxMutationFailure.classify(ArmadaError.unavailable) == .unconfirmed)
    #expect(SandboxMutationFailure.classify(ArmadaError.invalidResponse) == .unconfirmed)
    #expect(SandboxMutationFailure.classify(CancellationError()) == .unconfirmed)
}

@Test func promptAdmissionAndStopFollowTheSandboxAndItsTurn() throws {
    func decode(_ status: String, settled: Bool, prompt: String? = nil) throws -> SandboxDetail {
        try JSONDecoder().decode(SandboxDetail.self, from: Data(detail(status: status, settled: settled, prompt: prompt).utf8))
    }
    #expect(try decode("ready", settled: true).admission == .open)
    #expect(try decode("ready", settled: true, prompt: "finished").admission == .open)
    #expect(try decode("stopped", settled: true, prompt: "failed").admission == .open)
    #expect(try decode("running", settled: false, prompt: "running").admission == .turnRunning)
    #expect(try decode("ready", settled: true, prompt: "running").admission == .turnRunning)
    #expect(try decode("starting", settled: false).admission == .starting)
    #expect(try decode("stopping", settled: true).admission == .stopping)
    #expect(try decode("failed", settled: true).admission == .failed)
    #expect(try decode("deleted", settled: true).admission == .deleted)
    #expect(try decode("hibernating", settled: true).admission == .unknownStatus)
    #expect(try decode("running", settled: false).canStop)
    #expect(try !decode("stopped", settled: true).canStop)
    #expect(try !decode("stopping", settled: true).canStop)
}

private struct Entry: Identifiable, Equatable { let id: String; let body: String }

@Test func reReadEventsReplaceTheirBodyInPlaceAndNewOnesAppend() {
    var events = [Entry(id: "prompt", body: "running"), Entry(id: "message", body: "Hel")]
    #expect(EventStream.merge([Entry(id: "message", body: "Hello"), Entry(id: "prompt", body: "finished"), Entry(id: "next", body: "x")], into: &events))
    #expect(events == [Entry(id: "prompt", body: "finished"), Entry(id: "message", body: "Hello"), Entry(id: "next", body: "x")])
    #expect(!EventStream.merge([Entry(id: "next", body: "x")], into: &events))
    #expect(events.count == 3)
}

@Test func theLatestPageIsReadBackwardAndOlderPagesFromItsOlderCursor() async throws {
    let (client, transport) = try await signedIn([
        .init(status: 200, body: #"{"events":[],"cursor":"frontier","olderCursor":"o9","hasMore":true,"settled":true}"#),
        .init(status: 200, body: #"{"events":[],"cursor":"o9-next","olderCursor":"o1","hasMore":false,"settled":true}"#),
        .init(status: 200, body: #"{"events":[],"cursor":"frontier","hasMore":false,"settled":true}"#)
    ])
    let latest = try await client.sandboxEvents(id: sandboxID, backward: true)
    #expect(latest.cursor == "frontier")
    #expect(latest.olderCursor == "o9")
    let older = try await client.sandboxEvents(id: sandboxID, cursor: latest.olderCursor, backward: true)
    #expect(older.olderCursor == "o1")
    #expect(!older.hasMore)
    let requests = Array(await transport.requests.dropFirst(2))
    #expect(try body(requests[0]) == ["id": sandboxID, "org": "org-a", "direction": "backward"])
    #expect(try body(requests[1]) == ["id": sandboxID, "org": "org-a", "cursor": "o9", "direction": "backward"])
    let next = try await client.sandboxEvents(id: sandboxID, cursor: "frontier")
    #expect(next.cursor == "frontier")
    let allReads = Array(await transport.requests.dropFirst(2))
    #expect(allReads.count == 3)
    #expect(try body(allReads[2]) == ["id": sandboxID, "org": "org-a", "cursor": "frontier"])
}

@Test func anInvalidHistoryReadIsNotRetriedWithAnotherBudget() async throws {
    let (client, transport) = try await signedIn([
        .init(status: 400, body: #"{"error":{"code":"invalid_request","message":"Invalid cursor."}}"#)
    ])
    await #expect(throws: ArmadaServerFailure(cause: .http(400), explanation: "Invalid cursor.")) {
        _ = try await client.sandboxEvents(id: sandboxID, cursor: "invalid")
    }
    let reads = Array(await transport.requests.dropFirst(2))
    #expect(reads.count == 1)
    #expect(try body(reads[0]) == ["id": sandboxID, "org": "org-a", "cursor": "invalid"])
}

@Test func closedInterruptionReasonsOfferManualResendWithoutBlockingAdmission() throws {
    for reason in ["interrupted_by_provider_move", "interrupted_by_harness_exit", "future_reason"] {
        let json = detail(status: "ready", settled: true, prompt: "interrupted")
            .replacingOccurrences(of: #""reason":null"#, with: #""reason":"\#(reason)""#)
        let read = try JSONDecoder().decode(SandboxDetail.self, from: Data(json.utf8))
        #expect(read.admission == .open)
        #expect(read.prompt?.resendHint?.contains("prompt again") == true)
        #expect(read.prompt?.resendHint?.contains(reason) == false)
    }
}

// A response lost during background termination must not make the next app instance send again.
// This uses the same secure-session storage across two independent client lifetimes.
@Test func anInterruptedSandboxSendCannotBeRepeatedAfterRelaunch() async throws {
    let storage = MemoryStorage()
    let transport = ScriptedTransport([.init(status: 200, body: login), .init(status: 200, body: orgs)], storage: storage)
    let first = try ArmadaClient(transport: transport, storage: storage)
    try await first.verifyEmail(email: "person@example.test", code: "123456")
    try await first.selectOrganization("org-a")
    await #expect(throws: ArmadaError.unavailable) {
        _ = try await first.sendSandboxPrompt(id: sandboxID, text: "Keep this prompt")
    }

    let afterRelaunch = ScriptedTransport([])
    // Restore the bytes that existed at dispatch, not anything saved after the lost response.
    let snapshot = try #require(await transport.storageAtSend)
    let restored = try ArmadaClient(transport: afterRelaunch, storage: MemoryStorage(data: snapshot))
    try await restored.restore()
    await #expect(throws: ArmadaError.conflict) {
        _ = try await restored.sendSandboxPrompt(id: sandboxID, text: "Do not send another prompt")
    }
    #expect(await afterRelaunch.requests.isEmpty)
}

@Test func sandboxPromptRecoveryKeepsTextAndExplicitDismissalSurvivesRestore() async throws {
    let storage = MemoryStorage()
    let transport = ScriptedTransport([.init(status: 200, body: login), .init(status: 200, body: orgs)])
    let first = try ArmadaClient(transport: transport, storage: storage)
    try await first.verifyEmail(email: "person@example.test", code: "123456")
    try await first.selectOrganization("org-a")
    await #expect(throws: ArmadaError.unavailable) {
        _ = try await first.sendSandboxPrompt(id: sandboxID, text: "A prompt that may have arrived")
    }
    let restored = try ArmadaClient(transport: ScriptedTransport([]), storage: storage)
    try await restored.restore()
    let saved = try #require(await restored.unconfirmedSandboxPrompt(id: sandboxID))
    #expect(saved.text == "A prompt that may have arrived" && saved.orgID == "org-a")
    try await restored.dismissSandboxPrompt(id: saved.id)
    let afterDismissal = try ArmadaClient(transport: ScriptedTransport([]), storage: storage)
    try await afterDismissal.restore()
    #expect(try await afterDismissal.unconfirmedSandboxPrompt(id: sandboxID) == nil)
}

@Test func sandboxSendJournalSettlesOnlyDefiniteOutcomesAndIsClearedByNewLogin() async throws {
    for (status, body, uncertain) in [
        (200, #"{"id":"\#(sandboxID)","promptId":"p-1","conversationId":"c-1","status":"running"}"#, false),
        (400, #"{"error":{"code":"invalid_request","message":"invalid_request"}}"#, false),
        (403, #"{"error":{"code":"forbidden"}}"#, false),
        (503, #"{"error":{"code":"unavailable"}}"#, true),
    ] {
        let (client, transport) = try await signedIn([.init(status: status, body: body), .init(status: 200, body: login)])
        do { _ = try await client.sendSandboxPrompt(id: sandboxID, text: "Once only") } catch {}
        #expect((try await client.unconfirmedSandboxPrompt(id: sandboxID) != nil) == uncertain)
        #expect(await transport.requests.filter { $0.url?.path == "/api/v1/sandbox/send" }.count == 1)
        try await client.verifyEmail(email: "person@example.test", code: "654321")
        #expect(await client.pendingSandboxPrompts.isEmpty)
    }
}

@Test func sandboxSendAndDismissalFailClosedWhenSecureStorageCannotBeWritten() async throws {
    let storage = MemoryStorage()
    let transport = ScriptedTransport([.init(status: 200, body: login), .init(status: 200, body: orgs)])
    let client = try ArmadaClient(transport: transport, storage: storage)
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    storage.failWrites()
    await #expect(throws: ArmadaError.secureStorage) {
        _ = try await client.sendSandboxPrompt(id: sandboxID, text: "Must not be dispatched")
    }
    #expect(await transport.requests.count == 2)
    #expect(await client.pendingSandboxPrompts.isEmpty)

    let secondStorage = MemoryStorage()
    let secondTransport = ScriptedTransport([.init(status: 200, body: login), .init(status: 200, body: orgs)])
    let second = try ArmadaClient(transport: secondTransport, storage: secondStorage)
    try await second.verifyEmail(email: "person@example.test", code: "123456")
    try await second.selectOrganization("org-a")
    await #expect(throws: ArmadaError.unavailable) {
        _ = try await second.sendSandboxPrompt(id: sandboxID, text: "Keep uncertain")
    }
    let saved = try #require(await second.unconfirmedSandboxPrompt(id: sandboxID))
    secondStorage.failWrites()
    await #expect(throws: ArmadaError.secureStorage) { try await second.dismissSandboxPrompt(id: saved.id) }
    #expect(try await second.unconfirmedSandboxPrompt(id: sandboxID)?.id == saved.id)
}

@Test func sandboxPromptTrackingIsOriginAndOrganizationScopedAndSignOutClearsIt() async throws {
    let storage = MemoryStorage()
    let twoOrgs = #"{"orgs":[{"id":"org-a","name":"A","role":"member"},{"id":"org-b","name":"B","role":"member"}]}"#
    let transport = ScriptedTransport([
        .init(status: 200, body: login), .init(status: 200, body: twoOrgs),
        .init(status: 503, body: "{}"),
        .init(status: 200, body: twoOrgs), .init(status: 200, body: twoOrgs),
        .init(status: 200, body: #"{"ok":true}"#),
    ])
    let client = try ArmadaClient(transport: transport, storage: storage)
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    await #expect(throws: ArmadaError.unavailable) {
        _ = try await client.sendSandboxPrompt(id: sandboxID, text: "Private draft")
    }
    let otherOrigin = try ArmadaClient(origin: URL(string: "https://other.example.test")!, transport: ScriptedTransport([]), storage: storage)
    try await otherOrigin.restore()
    #expect(await otherOrigin.pendingSandboxPrompts.isEmpty)
    #expect(await !otherOrigin.isSignedIn)
    try await client.selectOrganization("org-b")
    #expect(try await client.unconfirmedSandboxPrompt(id: sandboxID) == nil)
    try await client.selectOrganization("org-a")
    #expect(try await client.unconfirmedSandboxPrompt(id: sandboxID)?.text == "Private draft")
    try await client.signOut()
    let afterSignOut = try ArmadaClient(transport: ScriptedTransport([]), storage: storage)
    try await afterSignOut.restore()
    #expect(await afterSignOut.pendingSandboxPrompts.isEmpty)
    #expect(await !afterSignOut.isSignedIn)
}

@Test func explainedSendFailuresPreserveAdmissionAndDurableUncertainty() async throws {
    for (status, code, classification) in [
        (400, "sandbox_not_ready", SandboxMutationFailure.refused),
        (409, "conflict", .refused),
        (403, "forbidden", .noAccess),
        (503, "dependency_unavailable", .unconfirmed),
        (400, "future_reason", .unconfirmed),
    ] {
        let body = String(decoding: try JSONSerialization.data(withJSONObject: [
            "error": ["code": code, "message": "The server explains this failure."]
        ]), as: UTF8.self)
        let (client, transport) = try await signedIn([.init(status: status, body: body)])
        do { _ = try await client.sendSandboxPrompt(id: sandboxID, text: "Only once"); Issue.record("Expected failure") }
        catch {
            #expect(error.localizedDescription == "The server explains this failure.")
            #expect(SandboxMutationFailure.classify(error) == classification)
        }
        #expect((try await client.unconfirmedSandboxPrompt(id: sandboxID) != nil) == (classification == .unconfirmed))
        #expect(await transport.requests.filter { $0.url?.path == "/api/v1/sandbox/send" }.count == 1)
    }
}

@Test func sandboxTurnsDecodeStructuredModelWaitsAndRemainCompatibleWithOlderServers() throws {
    let waiting = #"{"retryCount":2,"delayMs":20000,"totalWaitMs":30000,"retryAt":1762646420000,"waiting":true,"message":"Rate limited by the model provider, retrying in 20 s"}"#
    let completed = #"{"retryCount":2,"delayMs":20000,"totalWaitMs":30000,"retryAt":1762646420000,"waiting":false,"message":"Model provider rate-limit wait completed"}"#
    for (field, expectedWaiting) in [("", nil), (",\"rateLimit\":null", nil), (",\"rateLimit\":\(waiting)", true), (",\"rateLimit\":\(completed)", false)] as [(String, Bool?)] {
        let data = Data("{\"promptId\":\"pr_1\",\"state\":\"running\"\(field)}".utf8)
        let turn = try JSONDecoder().decode(SandboxTurn.self, from: data)
        #expect(turn.rateLimit?.waiting == expectedWaiting)
        if let rateLimit = turn.rateLimit {
            #expect(rateLimit.retryCount == 2)
            #expect(rateLimit.delayMs == 20000)
            #expect(rateLimit.totalWaitMs == 30000)
            #expect(rateLimit.retryAt == 1762646420000)
            #expect(rateLimit.message == (expectedWaiting == true ? "Rate limited by the model provider, retrying in 20 s" : "Model provider rate-limit wait completed"))
        }
    }
}

@Test func expiryAndRetentionFencePromptAdmission() throws {
    let now = try Date.ISO8601FormatStyle().parse("2026-11-16T00:00:00Z")
    for status in ["ready", "running", "stopped"] {
        let json = detail(status: status, settled: true).replacingOccurrences(of: "\"expiresAt\":null", with: "\"expiresAt\":\"2026-11-16T00:00:00Z\"")
        let value = try JSONDecoder().decode(SandboxDetail.self, from: Data(json.utf8))
        #expect(value.admission(at: now) == .expired)
        #expect(value.admission(at: now.addingTimeInterval(-1)) == .open)
    }
    for (provider, reason, note, expected) in [
        ("modal", "manual", "none", SandboxPromptAdmission.open),
        ("boat", "manual", "checkpoint_failed_disk_not_retained", .cannotResume),
        ("docker", "manual", "none", .cannotResume),
        ("docker", "idle_paused", "none", .open)
    ] {
        let json = detail(status: "stopped", settled: true)
            .replacingOccurrences(of: "\"provider\":\"modal\"", with: "\"provider\":\"\(provider)\",\"preservationNote\":\"\(note)\"")
            .replacingOccurrences(of: "\"statusReason\":null", with: "\"statusReason\":\"\(reason)\"")
        #expect(try JSONDecoder().decode(SandboxDetail.self, from: Data(json.utf8)).admission(at: now) == expected)
    }
}

@Test func stopReceiptRetainsDiskLossWarning() throws {
    let json = #"{"id":"fixture_id","status":"failed","preservationNote":"checkpoint_failed_disk_not_retained"}"#
    let receipt = try JSONDecoder().decode(SandboxStopReceipt.self, from: Data(json.utf8))
    #expect(receipt.preservationWarning?.contains("cannot resume") == true)
    #expect(SandboxPresentation.sandboxFailure("expired").contains("deadline"))
    #expect(!SandboxPresentation.sandboxFailure("future_internal_code").contains("future_internal_code"))
}
