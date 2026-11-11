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

/// A fake transport for the event stream (#812 contract): answers reads in order and records them.
private final class Script: @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [Result<ConversationPage<Entry>, Stop>]
    let log: Log
    init(_ replies: [Result<ConversationPage<Entry>, Stop>], log: Log) { self.replies = replies; self.log = log }
    func fetch(_ read: ConversationRead) throws(Stop) -> ConversationPage<Entry> {
        switch read {
        case .latest: log.append("read latest")
        case .older(let cursor): log.append("read older \(cursor)")
        case .newer(let cursor): log.append("read newer \(cursor ?? "start")")
        }
        let next: Result<ConversationPage<Entry>, Stop> = lock.withLock { replies.isEmpty ? .failure(Stop()) : replies.removeFirst() }
        return try next.get()
    }
}

private func page(_ ids: [String], cursor: String?, older: String? = nil, hasMore: Bool) -> Result<ConversationPage<Entry>, Stop> {
    .success(ConversationPage(events: ids.map { Entry(id: $0) }, cursor: cursor, olderCursor: older, hasMore: hasMore))
}

@MainActor
private func run(_ loader: ConversationLoader<Entry>, _ script: Script, backoff: Duration? = nil) async {
    await loader.run(
        clock: RecordingClock(log: script.log),
        fetch: { (read) throws(Stop) in try script.fetch(read) },
        show: { events in script.log.append("show \(events.map(\.id).joined(separator: ","))") },
        pollDelay: { .seconds(2) },
        // Each first failure backs off once; a second in a row stops the test run.
        onFailure: { _, consecutive in consecutive == 1 ? backoff : nil }
    )
}

@MainActor
@Test func theFirstRenderIsTheLatestPageFromOneReadAndFollowContinuesFromItsFrontier() async {
    let log = Log()
    let script = Script([
        page(["e8", "e9"], cursor: "c9", older: "o8", hasMore: true),
        page(["e10"], cursor: "c10", hasMore: false),
    ], log: log)
    let loader = ConversationLoader<Entry>(key: "sandbox:a", cache: nil)
    await run(loader, script)
    // One read before the first render, and it is the end of the conversation. Older history is
    // never read on its own; the poll timer runs only after the frontier is reached.
    #expect(log.all == [
        "read latest", "show e8,e9",
        "sleep 2s",
        "read newer c9", "show e8,e9,e10",
        "sleep 2s",
        "read newer c10",
    ])
    #expect(loader.hasOlder)
}

@MainActor
@Test func olderPagesArePrependedOnRequestAndStitchWithForwardFollowWithoutGapOrDuplicate() async throws {
    let log = Log()
    let script = Script([
        page(["e4", "e5"], cursor: "c5", older: "o4", hasMore: true),
        page(["e2", "e3"], cursor: "c3", older: "o2", hasMore: true),
        // The forward read re-sends e5 with a newer body and adds e6.
        .success(ConversationPage(events: [Entry(id: "e5", body: "grew"), Entry(id: "e6")], cursor: "c6", hasMore: false)),
        // The oldest page overlaps what is shown: e2 is not duplicated.
        page(["e1", "e2"], cursor: "c2", older: "o1", hasMore: false),
    ], log: log)
    let loader = ConversationLoader<Entry>(key: "k", cache: nil)
    let show: ConversationLoader<Entry>.Show = { events in log.append("show \(events.map(\.id).joined(separator: ","))") }
    let fetch = { (read: ConversationRead) throws(Stop) in try script.fetch(read) }
    try await loader.catchUp(fetch, show: show)
    try await loader.loadOlder(fetch, show: show)
    try await loader.catchUp(fetch, show: show)
    try await loader.loadOlder(fetch, show: show)
    // Nothing older remains: no read.
    try await loader.loadOlder(fetch, show: show)
    #expect(loader.snapshot.events == ["e1", "e2", "e3", "e4"].map { Entry(id: $0) } + [Entry(id: "e5", body: "grew"), Entry(id: "e6")])
    // Older pages never move the live frontier.
    #expect(loader.snapshot.cursor == "c6")
    #expect(!loader.hasOlder)
    #expect(log.all == [
        "read latest", "show e4,e5",
        "read older o4", "show e2,e3,e4,e5",
        "read newer c5", "show e2,e3,e4,e5,e6",
        "read older o2", "show e1,e2,e3,e4,e5,e6",
    ])
}

@MainActor
@Test func aConversationOpenedBeforeIsShownFromMemoryBeforeAnyRequestAndFollowsFromItsFrontier() async {
    let cache = ConversationCache<Entry>()
    await run(ConversationLoader(key: "sandbox:a", cache: cache), Script([page(["e1", "e2"], cursor: "c2", older: "o1", hasMore: true)], log: Log()))

    let log = Log()
    let loader = ConversationLoader<Entry>(key: "sandbox:a", cache: cache)
    await run(loader, Script([page(["e3"], cursor: "c3", hasMore: false)], log: log))
    #expect(log.all == ["show e1,e2", "read newer c2", "show e1,e2,e3", "sleep 2s", "read newer c3"])
    #expect(cache.snapshot(for: "sandbox:a")?.cursor == "c3")
    #expect(loader.hasOlder)
}

@MainActor
@Test func newerEventsReportedTogetherAreReadBackToBackBeforeThePollDelay() async {
    let log = Log()
    let script = Script([
        page(["e1"], cursor: "c1", older: "o1", hasMore: false),
        page(["e2"], cursor: "c2", hasMore: true),
        // More reported without an advancing cursor is not read again at once.
        page([], cursor: "c2", hasMore: true),
    ], log: log)
    await run(ConversationLoader(key: "k", cache: nil), script)
    #expect(log.all == ["read latest", "show e1", "sleep 2s", "read newer c1", "show e1,e2", "read newer c2", "sleep 2s", "read newer c2"])
}

@MainActor
@Test func anEmptyConversationIsShownAfterOneReadAndFollowedFromTheStart() async {
    let log = Log()
    await run(ConversationLoader(key: "k", cache: nil), Script([page([], cursor: nil, hasMore: false)], log: log))
    #expect(log.all == ["read latest", "show ", "sleep 2s", "read newer start"])
}

@MainActor
@Test func aServerWithoutBackwardReadsIsFollowedForwardAtOnce() async {
    let log = Log()
    // An older server ignores the direction and answers with its first page and no older cursor.
    let script = Script([page(["e1"], cursor: "c1", hasMore: true), page(["e2"], cursor: "c2", hasMore: false)], log: log)
    let loader = ConversationLoader<Entry>(key: "k", cache: nil)
    await run(loader, script)
    #expect(log.all == ["read latest", "show e1", "read newer c1", "show e1,e2", "sleep 2s", "read newer c2"])
    #expect(!loader.hasOlder)
}

@MainActor
@Test func aFailedFirstReadBacksOffOnTheClockAndRetriesTheLatestPage() async {
    let log = Log()
    let script = Script([.failure(Stop()), page(["e1"], cursor: "c1", older: "o1", hasMore: false)], log: log)
    await run(ConversationLoader(key: "k", cache: nil), script, backoff: .seconds(1))
    #expect(log.all == ["read latest", "sleep 1s", "read latest", "show e1", "sleep 2s", "read newer c1", "sleep 1s", "read newer c1"])
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

@MainActor
@Test func repeatedOpensReuseTheDerivedPresentationOfALongHistory() async {
    let cache = ConversationCache<Entry>()
    let events = (0..<2_000).map { Entry(id: "event-\($0)", body: "body-\($0)") }
    cache.store(ConversationSnapshot(events: events, cursor: "frontier"), for: "sandbox:a")
    var builds = 0
    var shown: [String] = []
    for _ in 0..<20 {
        let loader = ConversationLoader<Entry>(key: "sandbox:a", cache: cache)
        await loader.showCached { events in
            let value = await cache.rendered(for: "sandbox:a", events: events) { _ in
                builds += 1
                return "presentation-\(builds)"
            }
            shown.append(value)
        }
    }
    #expect(builds == 1)
    #expect(shown == Array(repeating: "presentation-1", count: 20))
    print("Conversation presentation work-count: events=2000 opens=20 builds=\(builds)")
}

@MainActor
@Test func cursorProgressKeepsPresentationButChangedEventsRebuildIt() async {
    let cache = ConversationCache<Entry>()
    let original = [Entry(id: "event", body: "before")]
    let changed = [Entry(id: "event", body: "after")]
    var builds = 0
    let build: @MainActor ([Entry]) async -> String = { events in
        builds += 1
        return events[0].body
    }
    cache.store(ConversationSnapshot(events: original, cursor: "c1"), for: "k")
    #expect(await cache.rendered(for: "k", events: original, build: build) == "before")
    cache.store(ConversationSnapshot(events: original, cursor: "c2"), for: "k")
    #expect(await cache.rendered(for: "k", events: original, build: build) == "before")
    #expect(builds == 1)
    cache.store(ConversationSnapshot(events: changed, cursor: "c3"), for: "k")
    #expect(await cache.rendered(for: "k", events: changed, build: build) == "after")
    #expect(builds == 2)
    // A stale reader can render its own window but cannot replace the current presentation.
    #expect(await cache.rendered(for: "k", events: original, build: build) == "before")
    #expect(await cache.rendered(for: "k", events: changed, build: build) == "after")
    #expect(builds == 3)
}

@MainActor
private final class SuspendedPresentation {
    let started: AsyncStream<Void>
    private let signal: AsyncStream<Void>.Continuation
    var release: CheckedContinuation<String, Never>?

    init() {
        (started, signal) = AsyncStream<Void>.makeStream()
    }

    func build() async -> String {
        await withCheckedContinuation { continuation in
            release = continuation
            signal.yield(())
            signal.finish()
        }
    }
}

@MainActor
@Test func lateRenderingCannotReviveForgottenOrEvictedPresentations() async {
    for clear in 0..<3 {
        let cache = ConversationCache<Entry>(capacity: 1)
        let snapshot = ConversationSnapshot(events: [Entry(id: "e")], cursor: "c")
        cache.store(snapshot, for: "k")
        let gate = SuspendedPresentation()
        let old = Task { await cache.rendered(for: "k", events: snapshot.events) { _ in await gate.build() } }
        for await _ in gate.started { break }
        switch clear {
        case 0: cache.remove("k")
        case 1: cache.removeAll()
        default: cache.store(snapshot, for: "other")
        }
        // Even identical events reintroduced after clearing have a different privacy lifetime.
        cache.store(snapshot, for: "k")
        let fresh = await cache.rendered(for: "k", events: snapshot.events) { _ in "fresh" }
        #expect(fresh == "fresh")
        gate.release?.resume(returning: "stale")
        #expect(await old.value == "stale")
        let retained = await cache.rendered(for: "k", events: snapshot.events) { _ in "unexpected rebuild" }
        #expect(retained == "fresh")
    }
}
