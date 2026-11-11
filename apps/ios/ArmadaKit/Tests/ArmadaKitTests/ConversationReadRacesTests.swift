import Foundation
import Testing
@testable import ArmadaKit

private struct Entry: Identifiable, Equatable, Sendable {
    let id: String
    var body = ""
}
private struct Stop: Error, Equatable {}

@MainActor
private final class SuspendedPage {
    let started: AsyncStream<Void>
    private let signal: AsyncStream<Void>.Continuation
    var release: CheckedContinuation<ConversationPage<Entry>, Never>?

    init() {
        (started, signal) = AsyncStream<Void>.makeStream()
    }

    func response() async -> ConversationPage<Entry> {
        await withCheckedContinuation { continuation in
            release = continuation
            signal.yield(())
            signal.finish()
        }
    }
}

@MainActor
@Test func aLateForwardReadCannotRollBackTheFrontierOrNewerEventBodies() async throws {
    let cache = ConversationCache<Entry>()
    cache.store(ConversationSnapshot(events: [Entry(id: "e", body: "before")], cursor: "c0"), for: "k")
    let loader = ConversationLoader<Entry>(key: "k", cache: cache)
    let gate = SuspendedPage()
    let late = Task {
        try await loader.catchUp({ (read: ConversationRead) async throws(Stop) -> ConversationPage<Entry> in
            #expect(read == .newer("c0"))
            return await gate.response()
        }, show: { _ in })
    }
    for await _ in gate.started { break }
    try await loader.catchUp({ _ throws(Stop) in
        ConversationPage(events: [Entry(id: "e", body: "fresh")], cursor: "c2", hasMore: false)
    }, show: { _ in })
    gate.release?.resume(returning: ConversationPage(events: [Entry(id: "e", body: "stale")], cursor: "c1", hasMore: false))
    try await late.value
    #expect(loader.snapshot.cursor == "c2")
    #expect(loader.snapshot.events == [Entry(id: "e", body: "fresh")])
    #expect(cache.snapshot(for: "k")?.cursor == "c2")
}

@MainActor
@Test func paginationAndLiveReadsPreserveBothContestedAndUncontestedUpdates() async throws {
    let cases: [(olderFirst: Bool, firstBody: String?, secondBody: String, expected: String)] = [
        (true, "fresh-older", "stale-forward", "fresh-older"),
        (true, nil, "fresh-forward", "fresh-forward"),
        (false, "fresh-forward", "stale-older", "fresh-forward"),
        (false, nil, "fresh-older", "fresh-older"),
    ]
    for sample in cases {
        let cache = ConversationCache<Entry>()
        cache.store(ConversationSnapshot(events: [Entry(id: "e", body: "before")], cursor: "c0", olderCursor: "o1", hasOlder: true), for: "k")
        let loader = ConversationLoader<Entry>(key: "k", cache: cache)
        let olderGate = SuspendedPage()
        let liveGate = SuspendedPage()
        let older = Task {
            try await loader.loadOlder({ (read: ConversationRead) async throws(Stop) -> ConversationPage<Entry> in
                #expect(read == .older("o1"))
                return await olderGate.response()
            }, show: { _ in })
        }
        for await _ in olderGate.started { break }
        let live = Task {
            try await loader.catchUp({ (read: ConversationRead) async throws(Stop) -> ConversationPage<Entry> in
                #expect(read == .newer("c0"))
                return await liveGate.response()
            }, show: { _ in })
        }
        for await _ in liveGate.started { break }
        let first = sample.firstBody.map { [Entry(id: "e", body: $0)] } ?? []
        let second = [Entry(id: "e", body: sample.secondBody)]
        if sample.olderFirst {
            olderGate.release?.resume(returning: ConversationPage(events: [Entry(id: "old")] + first, cursor: "ignored", olderCursor: "o0", hasMore: true))
            try await older.value
            liveGate.release?.resume(returning: ConversationPage(events: second + [Entry(id: "new")], cursor: "c1", hasMore: false))
            try await live.value
        } else {
            liveGate.release?.resume(returning: ConversationPage(events: first + [Entry(id: "new")], cursor: "c1", hasMore: false))
            try await live.value
            olderGate.release?.resume(returning: ConversationPage(events: [Entry(id: "old")] + second, cursor: "ignored", olderCursor: "o0", hasMore: true))
            try await older.value
        }
        #expect(loader.snapshot.events == [Entry(id: "old"), Entry(id: "e", body: sample.expected), Entry(id: "new")])
        #expect(loader.snapshot.cursor == "c1")
        #expect(loader.snapshot.olderCursor == "o0")
        #expect(!loader.isLoadingOlder)
    }
}

@MainActor
@Test func forgottenLoadersCannotPublishLateResponsesOrRestartReads() async throws {
    for direction in [ConversationRead.latest, .newer("c0"), .older("o1")] {
        let cache = ConversationCache<Entry>()
        if direction != .latest {
            cache.store(ConversationSnapshot(events: [Entry(id: "e")], cursor: "c0", olderCursor: "o1", hasOlder: true), for: "k")
        }
        let loader = ConversationLoader<Entry>(key: "k", cache: cache)
        let gate = SuspendedPage()
        let fetch = { (read: ConversationRead) async throws(Stop) -> ConversationPage<Entry> in
            #expect(read == direction)
            return await gate.response()
        }
        let pending = Task {
            if case .older = direction { try await loader.loadOlder(fetch, show: { _ in }) }
            else { try await loader.catchUp(fetch, show: { _ in }) }
        }
        for await _ in gate.started { break }
        loader.forget()
        gate.release?.resume(returning: ConversationPage(events: [Entry(id: "late")], cursor: "late", hasMore: false))
        try await pending.value
        #expect(cache.snapshot(for: "k") == nil)
        #expect(loader.snapshot.events.isEmpty)
        var reads = 0
        await loader.run(
            clock: ContinuousClock(),
            fetch: { (_: ConversationRead) throws(Stop) -> ConversationPage<Entry> in
                reads += 1
                throw Stop()
            },
            show: { _ in },
            pollDelay: { .seconds(1) },
            onFailure: { _, _ in nil }
        )
        // Both the old negative case and fixed path return before any clock sleep.
        #expect(reads == 0)
    }
}

@MainActor
@Test func aCancelledReadDoesNotMutateTheCachedWindowAfterItsResponseArrives() async throws {
    let cache = ConversationCache<Entry>()
    let original = [Entry(id: "e", body: "before")]
    cache.store(ConversationSnapshot(events: original, cursor: "c0"), for: "k")
    let loader = ConversationLoader<Entry>(key: "k", cache: cache)
    let gate = SuspendedPage()
    let pending = Task {
        try await loader.catchUp({ (_: ConversationRead) async throws(Stop) -> ConversationPage<Entry> in
            await gate.response()
        }, show: { _ in })
    }
    for await _ in gate.started { break }
    pending.cancel()
    gate.release?.resume(returning: ConversationPage(events: [Entry(id: "e", body: "late")], cursor: "late", hasMore: false))
    try await pending.value
    #expect(loader.snapshot.events == original)
    #expect(cache.snapshot(for: "k")?.cursor == "c0")
}
