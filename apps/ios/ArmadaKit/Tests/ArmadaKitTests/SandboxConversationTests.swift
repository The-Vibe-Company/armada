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
    return #"{"id":"\#(sandboxID)","golden":"web","visibility":"org","harness":"claude","repositoryDir":null,"model":"opus","reasoningEffort":"high","machineSize":null,"status":"\#(status)","statusReason":null,"providerState":"ready","conversationIds":["c_1"],"expiresAt":null,"prompt":\#(turn),"settled":\#(settled)}"#
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
    await #expect(throws: ArmadaError.forbidden) { _ = try await client.sandboxDetail(id: sandboxID) }
    await #expect(throws: ArmadaError.http(404)) { _ = try await client.sandboxEvents(id: sandboxID) }
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
    do { _ = try await client.sendSandboxPrompt(id: sandboxID, text: "Unknown"); Issue.record("Expected a failure") }
    catch { #expect(SandboxMutationFailure.classify(error) == .unconfirmed) }
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
    #expect(try body(requests[0]) == ["id": sandboxID, "org": "org-a", "prompt": "Add tests"])
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
        .init(status: 400, body: #"{"error":{"code":"invalid_request","message":"An event exceeds maxBytes; increase the event page budget."}}"#),
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
    // A page refused because one event exceeds the default budget is read again with the largest.
    let next = try await client.sandboxEvents(id: sandboxID, cursor: "frontier")
    #expect(next.cursor == "frontier")
    let retried = Array(await transport.requests.suffix(2))
    #expect(try body(retried[0]) == ["id": sandboxID, "org": "org-a", "cursor": "frontier"])
    let raised = try JSONSerialization.jsonObject(with: retried[1].httpBody ?? Data()) as? NSDictionary
    #expect(raised == ["id": sandboxID, "org": "org-a", "cursor": "frontier", "maxBytes": 1_048_576])
}

@Test func closedInterruptionReasonsOfferManualResendWithoutBlockingAdmission() throws {
    for reason in ["interrupted_by_provider_move", "interrupted_by_harness_exit", "future_reason"] {
        let json = detail(status: "ready", settled: true, prompt: "interrupted")
            .replacingOccurrences(of: #""reason":null"#, with: #""reason":"\#(reason)""#)
        let read = try JSONDecoder().decode(SandboxDetail.self, from: Data(json.utf8))
        #expect(read.admission == .open)
        #expect((read.prompt?.resendHint != nil) == (reason != "future_reason"))
    }
}
