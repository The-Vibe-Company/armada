import Foundation
import Testing
@testable import ArmadaKit

private struct Entry: Identifiable, Equatable, Sendable {
    let id: String
    var body = ""
}

private struct Stop: Error, Equatable {}

/// Everything that happened, in order: reads, renders and clock sleeps.
private final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    func append(_ line: String) { lock.withLock { lines.append(line) } }
    var all: [String] { lock.withLock { lines } }
}

/// An injected clock: records each sleep and returns at once, so no test waits on wall-clock time.
private struct RecordingClock: Clock {
    struct Instant: InstantProtocol {
        var offset: Duration
        func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
        func duration(to other: Instant) -> Duration { other.offset - offset }
        static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
    }
    let log: Log
    var now: Instant { Instant(offset: .zero) }
    var minimumResolution: Duration { .zero }
    func sleep(until deadline: Instant, tolerance: Duration?) async throws {
        log.append("sleep \(deadline.offset.components.seconds)s")
    }
}

/// A fake transport for the event stream: answers reads in order and records them.
private final class Script: @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [Result<ConversationPage<Entry>, Stop>]
    let log: Log
    init(_ replies: [Result<ConversationPage<Entry>, Stop>], log: Log) { self.replies = replies; self.log = log }
    func fetch(_ cursor: String?, _ read: ConversationRead) throws(Stop) -> ConversationPage<Entry> {
        log.append("read \(cursor ?? "start") \(read == .page ? "page" : "catchUp")")
        let next: Result<ConversationPage<Entry>, Stop> = lock.withLock { replies.isEmpty ? .failure(Stop()) : replies.removeFirst() }
        return try next.get()
    }
}

private func page(_ ids: [String], cursor: String?, hasMore: Bool) -> Result<ConversationPage<Entry>, Stop> {
    .success(ConversationPage(events: ids.map { Entry(id: $0) }, cursor: cursor, hasMore: hasMore))
}

@MainActor
private func run(_ loader: ConversationLoader<Entry>, _ script: Script, backoff: Duration? = nil) async {
    await loader.run(
        clock: RecordingClock(log: script.log),
        fetch: { (cursor, read) throws(Stop) in try script.fetch(cursor, read) },
        show: { events in script.log.append("show \(events.map(\.id).joined(separator: ","))") },
        pollDelay: { .seconds(2) },
        // Each first failure backs off once; a second in a row stops the test run.
        onFailure: { _, consecutive in consecutive == 1 ? backoff : nil }
    )
}

@MainActor
@Test func firstRenderNeverWaitsForMoreThanOnePageAndHistoryCatchesUpWithoutAPollDelay() async {
    let log = Log()
    let script = Script([
        page(["e1", "e2"], cursor: "c1", hasMore: true),
        page(["e3", "e4", "e5"], cursor: "c3", hasMore: false),
    ], log: log)
    let loader = ConversationLoader<Entry>(key: "sandbox:a", cache: nil)
    await run(loader, script)
    // The first page is shown before anything else is read; the rest of the history is one
    // catch-up read, back to back; only then does the poll timer run.
    #expect(log.all == [
        "read start page", "show e1,e2",
        "read c1 catchUp", "show e1,e2,e3,e4,e5",
        "sleep 2s",
        "read c3 page",
    ])
    #expect(loader.isCaughtUp)
}

@MainActor
@Test func aConversationOpenedBeforeIsShownFromMemoryBeforeAnyRequestAndResumesAtItsCursor() async {
    let cache = ConversationCache<Entry>()
    let first = Log()
    await run(ConversationLoader(key: "sandbox:a", cache: cache), Script([page(["e1", "e2"], cursor: "c2", hasMore: false)], log: first))

    let log = Log()
    let loader = ConversationLoader<Entry>(key: "sandbox:a", cache: cache)
    await run(loader, Script([page(["e3"], cursor: "c3", hasMore: false)], log: log))
    #expect(log.all == ["show e1,e2", "read c2 page", "show e1,e2,e3", "sleep 2s", "read c3 page"])
    #expect(cache.snapshot(for: "sandbox:a")?.cursor == "c3")
}

@MainActor
@Test func rereadEventsAreStitchedInPlaceAndTheCursorNeverMovesBack() async throws {
    let log = Log()
    let script = Script([
        page(["e1", "e2"], cursor: "c2", hasMore: false),
        // An overlapping read: e2 grew, e3 is new, and no cursor came back.
        .success(ConversationPage(events: [Entry(id: "e2", body: "grew"), Entry(id: "e3")], cursor: nil, hasMore: false)),
        // More reported without an advancing cursor is not read again at once.
        page([], cursor: "c2", hasMore: true),
    ], log: log)
    let loader = ConversationLoader<Entry>(key: "k", cache: nil)
    let show: ConversationLoader<Entry>.Show = { events in log.append("show \(events.map(\.id).joined(separator: ","))") }
    let fetch = { (cursor: String?, read: ConversationRead) throws(Stop) in try script.fetch(cursor, read) }
    try await loader.catchUp(fetch, show: show)
    try await loader.catchUp(fetch, show: show)
    try await loader.catchUp(fetch, show: show)
    #expect(loader.snapshot.events == [Entry(id: "e1"), Entry(id: "e2", body: "grew"), Entry(id: "e3")])
    #expect(loader.snapshot.cursor == "c2")
    #expect(log.all == ["read start page", "show e1,e2", "read c2 page", "show e1,e2,e3", "read c2 page"])
}

@MainActor
@Test func aFailedCatchUpBacksOffOnTheClockAndIsNeverTriedAgain() async {
    let log = Log()
    let script = Script([
        page(["e1"], cursor: "c1", hasMore: true),
        .failure(Stop()),
        page(["e2"], cursor: "c2", hasMore: true),
        page(["e3"], cursor: "c3", hasMore: false),
    ], log: log)
    await run(ConversationLoader(key: "k", cache: nil), script, backoff: .seconds(1))
    #expect(log.all == [
        "read start page", "show e1",
        "read c1 catchUp", "sleep 1s",
        // A history too long for one response (a timeout) must not loop on catch-up reads.
        "read c1 page", "show e1,e2",
        "read c2 page", "show e1,e2,e3",
        "sleep 2s", "read c3 page", "sleep 1s", "read c3 page",
    ])
}

@MainActor
@Test func anEmptyConversationIsShownAfterItsFirstRead() async {
    let log = Log()
    await run(ConversationLoader(key: "k", cache: nil), Script([page([], cursor: nil, hasMore: false)], log: log))
    #expect(log.all == ["read start page", "show ", "sleep 2s", "read start page"])
}

@MainActor
@Test func theCacheKeepsTheMostRecentConversationsAndForgetsOnRequest() {
    let cache = ConversationCache<Entry>(capacity: 2)
    cache.store(ConversationSnapshot(events: [Entry(id: "a")], cursor: "a"), for: "a")
    cache.store(ConversationSnapshot(events: [Entry(id: "b")], cursor: "b"), for: "b")
    _ = cache.snapshot(for: "a")
    cache.store(ConversationSnapshot(events: [Entry(id: "c")], cursor: "c"), for: "c")
    #expect(cache.keys == ["a", "c"])
    let loader = ConversationLoader<Entry>(key: "a", cache: cache)
    #expect(loader.snapshot.cursor == "a")
    loader.forget()
    #expect(cache.snapshot(for: "a") == nil)
    cache.removeAll()
    #expect(cache.keys.isEmpty)
}
