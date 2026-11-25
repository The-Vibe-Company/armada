import Foundation
import Testing
@testable import ArmadaKit

private final class SSEStorage: SessionStorage, @unchecked Sendable {
    private let lock = NSLock(); private var data: Data?
    func load() -> Data? { lock.withLock { data } }; func save(_ v: Data) { lock.withLock { data = v } }; func remove() { lock.withLock { data = nil } }
}
private actor SSETransport: ArmadaTransport {
    struct Reply: Sendable { let status: Int, contentType: String, chunks: [Data] }
    private var http: [(Int, String)], streams: [Reply]; private(set) var requests: [URLRequest] = []
    init(http: [(Int, String)], streams: [Reply]) { self.http = http; self.streams = streams }
    func send(_ r: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (s, b) = http.removeFirst(); return (Data(b.utf8), HTTPURLResponse(url: r.url!, statusCode: s, httpVersion: nil, headerFields: nil)!)
    }
    nonisolated func stream(_ r: URLRequest) -> AsyncThrowingStream<ArmadaStreamEvent, Error> {
        AsyncThrowingStream { c in
            let t = Task {
                guard let reply = await self.next(r) else { c.finish(throwing: URLError(.notConnectedToInternet)); return }
                c.yield(.response(HTTPURLResponse(url: r.url!, statusCode: reply.status, httpVersion: nil, headerFields: reply.contentType.isEmpty ? nil : ["Content-Type": reply.contentType])!))
                for chunk in reply.chunks { c.yield(.data(chunk)) }; c.finish()
            }
            c.onTermination = { @Sendable _ in t.cancel() }
        }
    }
    private func next(_ r: URLRequest) -> Reply? { requests.append(r); return streams.isEmpty ? nil : streams.removeFirst() }
}
private let sseID = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b"
private func signedInSSE(_ streams: [SSETransport.Reply]) async throws -> (ArmadaClient, SSETransport) {
    let t = SSETransport(http: [(200, #"{"accessToken":"fixture-access","refreshToken":"fixture-refresh","expiresAt":"2099-01-01T00:00:00Z"}"#), (200, #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#)], streams: streams)
    let c = try ArmadaClient(transport: t, storage: SSEStorage())
    try await c.verifyEmail(email: "person@example.test", code: "123456"); try await c.selectOrganization("org-a"); return (c, t)
}

@Test func streamsInlineEventsTransitionsTailAndLastEventIDResume() async throws {
    let f10 = "id: 10\r\ndata: {\"id\":\"10\",\"sandboxId\":\"\(sseID)\",\"sequence\":\"10\",\"kind\":\"runtime_event\",\"ref\":\"10\",\"createdAt\":\"2026-11-25T18:00:00Z\",\"event\":{\"id\":\"e10\",\"at\":1762646400000,\"kind\":\"message\",\"text\":\"Hi 🚀\",\"partial\":true,\"messageId\":\"m1\",\"textMode\":\"delta\",\"tools\":[]}}\r\n\r\n"
    let bytes = Data(f10.utf8), split = bytes.firstIndex(of: 0xF0)! + 2
    let tail = ": heartbeat\n\nid: 10\ndata: {\"id\":\"10\",\"sandboxId\":\"\(sseID)\",\"sequence\":\"10\",\"kind\":\"runtime_event\",\"ref\":\"10\",\"createdAt\":\"2026-11-25T18:00:01Z\"}\n\nid: 11\ndata: {\"id\":\"11\",\"sandboxId\":\"\(sseID)\",\"sequence\":\"11\",\"kind\":\"runtime_event\",\"ref\":\"11\",\"createdAt\":\"2026-11-25T18:00:02Z\"}\n\nid: 12\ndata: {\"id\":\"12\",\"sandboxId\":\"\(sseID)\",\"sequence\":null,\"kind\":\"transition\",\"ref\":\"3\",\"createdAt\":\"2026-11-25T18:00:03Z\",\"status\":\"ready\",\"statusReason\":\"idle\"}\n\n"
    let resumed = "id: 12\ndata: {\"id\":\"12\",\"sandboxId\":\"\(sseID)\",\"sequence\":null,\"kind\":\"transition\",\"ref\":\"3\",\"createdAt\":\"2026-11-25T18:00:03Z\",\"status\":\"ready\"}\n\nid: 13\ndata: {\"id\":\"13\",\"sandboxId\":\"\(sseID)\",\"sequence\":\"13\",\"kind\":\"runtime_event\",\"ref\":\"13\",\"createdAt\":\"2026-11-25T18:00:04Z\",\"event\":{\"id\":\"e13\",\"at\":1762646404000,\"kind\":\"prompt\",\"text\":\"Done\",\"status\":\"finished\",\"promptId\":\"pr_1\"}}\n\n"
    let (client, transport) = try await signedInSSE([.init(status: 200, contentType: "text/event-stream", chunks: [Data(": connected\n\n".utf8), bytes.prefix(split), bytes.dropFirst(split), Data(tail.utf8)]), .init(status: 200, contentType: "text/event-stream", chunks: [Data(resumed.utf8)])])
    var first: [SandboxStreamEvent] = []; for try await item in client.streamSandboxEvents(id: sseID) { first.append(item) }
    try #require(first.count == 4); #expect(first[0] == .connected)
    if case .frame(let f) = first[1], case .runtimeEvent(let ev?) = f.kind, case .message(let t, true, let mid, let mode, _, _) = ev.body { #expect(f.id == "10" && t == "Hi 🚀" && mid == "m1" && mode == "delta") } else { Issue.record("Expected frame 10") }
    if case .frame(let f) = first[2] { #expect(f.id == "11" && f.kind == .runtimeEvent(nil)) } else { Issue.record("Expected frame 11") }
    if case .frame(let f) = first[3] { #expect(f.id == "12" && f.kind == .transition(status: "ready", statusReason: "idle")) } else { Issue.record("Expected frame 12") }
    var second: [SandboxStreamEvent] = []; for try await item in client.streamSandboxEvents(id: sseID, lastEventID: "12") { second.append(item) }
    try #require(second.count == 2); if case .frame(let f) = second[1] { #expect(f.id == "13") } else { Issue.record("Expected frame 13") }
    let reqs = await transport.requests; try #require(reqs.count == 2)
    #expect(reqs[0].httpMethod == "GET" && reqs[0].url?.path == "/api/v1/events" && reqs[0].url?.query == "sandbox=\(sseID)&cursor=tail" && reqs[0].value(forHTTPHeaderField: "Accept") == "text/event-stream" && reqs[0].value(forHTTPHeaderField: "Last-Event-ID") == nil)
    #expect(reqs[1].url?.query == "sandbox=\(sseID)" && reqs[1].value(forHTTPHeaderField: "Last-Event-ID") == "12")
}

@Test func sseRejectsInvalidInputsAuthErrorsWrongContentTypeAndMismatchedSandbox() async throws {
    let bad = "id: 1\ndata: {\"id\":\"1\",\"sandboxId\":\"00000000-0000-4000-8000-000000000000\",\"sequence\":null,\"kind\":\"transition\",\"ref\":\"1\",\"createdAt\":\"2026-11-25T18:00:00Z\",\"status\":\"ready\"}\n\n"
    let (client, _) = try await signedInSSE([.init(status: 401, contentType: "application/json", chunks: []), .init(status: 403, contentType: "application/json", chunks: []), .init(status: 503, contentType: "application/json", chunks: []), .init(status: 200, contentType: "application/json", chunks: []), .init(status: 200, contentType: "text/event-stream", chunks: [Data(bad.utf8)])])
    func drain(_ s: AsyncThrowingStream<SandboxStreamEvent, Error>) async throws { for try await _ in s {} }
    await #expect(throws: ArmadaError.invalidRequest) { try await drain(client.streamSandboxEvents(id: "../bad")) }
    await #expect(throws: ArmadaError.invalidRequest) { try await drain(client.streamSandboxEvents(id: sseID, lastEventID: "tail")) }
    for expected in [ArmadaError.signedOut, .forbidden, .unavailable, .invalidResponse, .invalidResponse] { await #expect(throws: expected) { try await drain(client.streamSandboxEvents(id: sseID)) } }
}
