import Foundation
import Testing
@testable import ArmadaKit

// #847: a follow-up sent after the turn finished is a new message, never a steer that leaves the
// orchestrator unconfirmed. Synthetic fixtures; a fake transport and an injected clock, no waits.

private final class FollowUpStorage: SessionStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    func load() -> Data? { lock.withLock { data } }
    func save(_ value: Data) { lock.withLock { data = value } }
    func remove() { lock.withLock { data = nil } }
}

/// The Armada API: answers requests in order and records them.
private actor FollowUpTransport: ArmadaTransport {
    private var replies: [(Int, String)]
    private(set) var requests: [URLRequest] = []
    init(_ replies: [(Int, String)]) { self.replies = replies }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        guard !replies.isEmpty else { throw URLError(.networkConnectionLost) }
        let (status, body) = replies.removeFirst()
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
    /// The commands sent: `steer` or `message`, with their text and idempotency key.
    var commands: [(action: String, text: String, key: String)] {
        requests.compactMap { request in
            guard request.httpMethod == "POST", let path = request.url?.path, path.hasPrefix("/api/v1/orchestrators/"),
                  let body = request.httpBody,
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
            return (String(path.split(separator: "/").last ?? ""), json["text"] as? String ?? "",
                    request.value(forHTTPHeaderField: "Idempotency-Key") ?? "")
        }
    }
}

private let session = #"{"accessToken":"fixture-access","refreshToken":"fixture-refresh","expiresAt":"2099-01-01T00:00:00Z"}"#
private let orgs = #"{"orgs":[{"id":"org-a","name":"Team","role":"member"}]}"#
private let enabled = #"{"version":1,"enabled":true,"reason":null}"#

private func receipt(_ kind: String, _ state: String, revision: Int, errorCode: String? = nil) -> String {
    let code = errorCode.map { #""\#($0)""# } ?? "null"
    return #"{"version":1,"id":"op-\#(kind)-\#(revision)","orchestratorId":"orch-a","kind":"\#(kind)","state":"\#(state)","revision":\#(revision),"errorCode":\#(code)}"#
}

private func signedIn(_ replies: [(Int, String)]) async throws -> (ArmadaClient, FollowUpTransport) {
    let transport = FollowUpTransport([(200, session), (200, orgs)] + replies)
    let client = try ArmadaClient(transport: transport, storage: FollowUpStorage())
    try await client.verifyEmail(email: "person@example.test", code: "123456")
    try await client.selectOrganization("org-a")
    return (client, transport)
}

/// The app's send: one saved command per request, submitted once.
private func command(_ client: ArmadaClient, _ intent: FollowUpIntent, _ text: String, revision: Int) async throws -> OrchestratorOperation {
    let saved = try await client.prepareOrchestratorMutation(
        id: "orch-a", action: intent == .steer ? .steer : .message, expectedRevision: revision, text: text
    )
    return try await client.submitOrchestratorOperation(saved.id)
}

private func refusedForNoTurn(_ receipt: OrchestratorOperation) -> Bool {
    FollowUp.refusedForNoRunningTurn(kind: receipt.kind.rawValue, state: receipt.state.rawValue, errorCode: receipt.errorCode)
}

/// One prompt status as the conversation stream reports it; the latest status of a prompt wins.
private struct TurnEvent: Identifiable, Equatable, Sendable {
    let id: String
    let promptID: String
    let status: String
}

private struct Stop: Error {}

/// The conversation stream, read in order; an empty script ends a follow.
private final class TurnStream: @unchecked Sendable {
    private let lock = NSLock()
    private var pages: [ConversationPage<TurnEvent>]
    init(_ pages: [ConversationPage<TurnEvent>]) { self.pages = pages }
    func fetch(_ read: ConversationRead) throws(Stop) -> ConversationPage<TurnEvent> {
        guard let next = lock.withLock({ pages.isEmpty ? nil : pages.removeFirst() }) else { throw Stop() }
        return next
    }
}

private func page(_ events: [TurnEvent], cursor: String) -> ConversationPage<TurnEvent> {
    ConversationPage(events: events, cursor: cursor, hasMore: false)
}

/// What the screen shows: the working indicator, recomputed on every render.
@MainActor
private final class Screen {
    var activity = TurnActivity()
    var renders: [Bool] = []
    func show(_ events: [TurnEvent]) {
        var active: [String: String] = [:]
        for event in events { active[event.promptID] = ["queued", "running"].contains(event.status) ? event.status : nil }
        activity.streamReported(active)
        renders.append(activity.isWorking)
    }
}

private final class Sleeps: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Duration] = []
    func append(_ value: Duration) { lock.withLock { values.append(value) } }
    var all: [Duration] { lock.withLock { values } }
}

/// An injected clock: records each sleep and returns at once.
private struct RecordingClock: Clock {
    struct Instant: InstantProtocol {
        var offset: Duration
        func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
        func duration(to other: Instant) -> Duration { other.offset - offset }
        static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
    }
    let sleeps: Sleeps
    var now: Instant { Instant(offset: .zero) }
    var minimumResolution: Duration { .zero }
    func sleep(until deadline: Instant, tolerance: Duration?) async throws { sleeps.append(deadline.offset) }
}

@MainActor
@Test func aFollowUpWrittenWhileTheTurnRanIsSentAsAMessageWhenTheTurnFinishedMeanwhile() async throws {
    // The person opens the conversation while the first turn runs: the composer offers Steer.
    let stream = TurnStream([
        page([TurnEvent(id: "e1", promptID: "p1", status: "running")], cursor: "c1"),
        // It finishes while they type: the server publishes the turn's final status (#847).
        page([TurnEvent(id: "e2", promptID: "p1", status: "finished")], cursor: "c2"),
    ])
    let loader = ConversationLoader<TurnEvent>(key: "orchestrator:orch-a", cache: nil)
    let screen = Screen()
    try await loader.catchUp({ (read) throws(Stop) in try stream.fetch(read) }, show: screen.show)
    #expect(screen.activity.isWorking)

    // They press send with Steer chosen: the conversation is read again before deciding.
    try await loader.catchUp({ (read) throws(Stop) in try stream.fetch(read) }, show: screen.show)
    let intent = FollowUp.intent(requested: .steer, turnRunning: screen.activity.isWorking)
    #expect(intent == .message)

    let (client, transport) = try await signedIn([(200, enabled), (202, receipt("message", "succeeded", revision: 3))])
    let delivery = try await FollowUp.deliver(
        as: intent,
        send: { try await command(client, intent, "How many sandboxes run?", revision: 2) },
        refusedForNoRunningTurn: refusedForNoTurn,
        sendAsMessage: { Issue.record("a message is never resent"); throw Stop() }
    )
    #expect(delivery.intent == .message && !delivery.resentAsMessage && delivery.receipt.state == .succeeded)
    // Exactly one request, a new message: never a steer to a turn that has ended.
    #expect(await transport.commands.map(\.action) == ["message"])
}

@MainActor
@Test func aSteerRefusedBecauseNoTurnRunsIsSentOnceAsANewMessage() async throws {
    let (client, transport) = try await signedIn([
        (200, enabled), (200, receipt("steer", "failed", revision: 3, errorCode: "no_running_turn")),
        (200, enabled), (202, receipt("message", "succeeded", revision: 4)),
    ])
    let screen = Screen()
    screen.show([TurnEvent(id: "e1", promptID: "p1", status: "running")])
    let text = "How many sandboxes run?"
    let delivery = try await FollowUp.deliver(
        as: .steer,
        send: { try await command(client, .steer, text, revision: 2) },
        refusedForNoRunningTurn: refusedForNoTurn,
        sendAsMessage: {
            // The refusal proves the turn ended: the indicator clears before the stream says so.
            screen.activity.noTurnRuns()
            return try await command(client, .message, text, revision: 3)
        }
    )
    // One intent: the same text, sent once more as a new message under its own key. Nothing is
    // left unconfirmed, so no Retry or Dismiss is offered.
    #expect(delivery.intent == .message && delivery.resentAsMessage && delivery.receipt.state == .succeeded)
    let commands = await transport.commands
    #expect(commands.map(\.action) == ["steer", "message"])
    #expect(commands.allSatisfy { $0.text == text })
    #expect(commands[0].key != commands[1].key)
    #expect(!screen.activity.isWorking)
}

@MainActor
@Test func onlyADefiniteNoRunningTurnRefusalIsResent() async throws {
    // An unknown outcome (the response was lost) may have reached the turn: it is never resent.
    let (lost, lostTransport) = try await signedIn([(200, enabled)])
    await #expect(throws: (any Error).self) {
        _ = try await FollowUp.deliver(
            as: .steer,
            send: { try await command(lost, .steer, "Stop after the tests", revision: 2) },
            refusedForNoRunningTurn: refusedForNoTurn,
            sendAsMessage: { Issue.record("an unknown outcome is never resent"); throw Stop() }
        )
    }
    #expect(await lostTransport.commands.map(\.action) == ["steer"])

    // Another refusal is shown as itself, and a refused message is never turned into anything else.
    #expect(!FollowUp.refusedForNoRunningTurn(kind: "steer", state: "failed", errorCode: "conflict"))
    #expect(!FollowUp.refusedForNoRunningTurn(kind: "steer", state: "uncertain", errorCode: "no_running_turn"))
    #expect(!FollowUp.refusedForNoRunningTurn(kind: "message", state: "failed", errorCode: "no_running_turn"))
    #expect(FollowUp.intent(requested: .message, turnRunning: true) == .message)
    #expect(FollowUp.intent(requested: .steer, turnRunning: true) == .steer)
}

@MainActor
@Test func theWorkingIndicatorClearsOnTheReadThatShowsTheTurnFinished() async {
    let stream = TurnStream([
        page([TurnEvent(id: "e1", promptID: "p1", status: "running")], cursor: "c1"),
        // No follow-up is sent: the server's published completion is the only new event.
        page([TurnEvent(id: "e2", promptID: "p1", status: "finished")], cursor: "c2"),
    ])
    let loader = ConversationLoader<TurnEvent>(key: "orchestrator:orch-a", cache: nil)
    let screen = Screen()
    let sleeps = Sleeps()
    await loader.run(
        clock: RecordingClock(sleeps: sleeps),
        fetch: { (read) throws(Stop) in try stream.fetch(read) },
        show: screen.show,
        // The app's follow: quick while a turn runs.
        pollDelay: { screen.activity.isWorking ? .seconds(2) : .seconds(6) },
        onFailure: { _, _ in nil }
    )
    // Working, then cleared by the very read that brought the finish; one short poll between.
    #expect(screen.renders == [true, false])
    #expect(sleeps.all == [.seconds(2), .seconds(6)])

    // A steer refused because no turn runs clears it at once, though the stream still lists the
    // turn; a turn the stream reports anew (another one, or a queued one now running) counts again.
    var activity = TurnActivity()
    activity.streamReported(["p1": "running", "p2": "queued"])
    activity.noTurnRuns()
    #expect(!activity.isWorking)
    activity.streamReported(["p1": "running", "p2": "queued"])
    #expect(!activity.isWorking)
    activity.streamReported(["p1": "running", "p2": "running"])
    #expect(activity.isWorking)
    activity.streamReported(["p1": "running", "p3": "queued"])
    #expect(activity.isWorking)
    activity.streamReported([:])
    activity.streamReported(["p1": "running"])
    #expect(activity.isWorking)
}
