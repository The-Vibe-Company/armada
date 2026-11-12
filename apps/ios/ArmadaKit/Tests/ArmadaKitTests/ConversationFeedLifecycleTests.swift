import Foundation
import Testing
@testable import ArmadaKit

private enum Failure: Error, Equatable, Sendable { case offline, unsupported, denied }
private struct Entry: Identifiable, Equatable, Sendable { let id: String }

@MainActor
private final class Deferred<Value: Sendable> {
    let started: AsyncStream<Void>
    private let signal: AsyncStream<Void>.Continuation
    var release: CheckedContinuation<Value, Never>?

    init() { (started, signal) = AsyncStream<Void>.makeStream() }

    func value() async -> Value {
        await withCheckedContinuation { continuation in
            release = continuation
            signal.yield(())
            signal.finish()
        }
    }
}

@MainActor
@Test func cachedHistorySurvivesOfflineFailureAndRefreshRecoversAnActiveFollower() {
    let memory = ConversationCache<Entry>()
    memory.store(ConversationSnapshot(events: [Entry(id: "cached")], cursor: "c0"), for: "k")
    let loader = ConversationLoader<Entry>(key: "k", cache: memory)
    var lifecycle = ConversationFeedLifecycle<Failure>()
    var visible: [Entry] = []
    #expect(lifecycle.canKeepHistory(hasPublished: false, hasWindow: loader.snapshot.hasTail))
    #expect(!lifecycle.canKeepHistory(hasPublished: false, hasWindow: false))
    lifecycle.publish(loader.snapshot.events) { visible = $0 }
    lifecycle.readFailed(.offline, retryable: true, message: "Check your connection")
    #expect(visible == [Entry(id: "cached")])
    #expect(lifecycle.connection == .reconnecting("Check your connection"))
    #expect(lifecycle.refreshSucceeded())
    #expect(lifecycle.connection == .live)
    #expect(!lifecycle.refreshSucceeded())
}

@Test func stoppedFollowersStayPausedOnFailedRefreshAndRestartOnlyAfterSuccess() {
    var lifecycle = ConversationFeedLifecycle<Failure>()
    lifecycle.readFailed(.unsupported, retryable: false, message: "Unsupported")
    #expect(lifecycle.connection == .stopped(.unsupported))
    lifecycle.refreshFailed(.offline, message: "Still offline")
    #expect(lifecycle.connection == .stopped(.offline))
    #expect(lifecycle.refreshSucceeded())
    #expect(lifecycle.connection == .live)
    lifecycle.readFailed(.offline, retryable: true, message: "First failure")
    lifecycle.refreshFailed(.offline, message: "New server reason")
    #expect(lifecycle.connection == .reconnecting("New server reason"))
    #expect(lifecycle.refreshSucceeded())
    #expect(lifecycle.connection == .live)
}

@MainActor
@Test func deniedConversationErasesPublishedHistoryAndRejectsDelayedCacheWrites() async throws {
    let memory = ConversationCache<Entry>()
    memory.store(ConversationSnapshot(events: [Entry(id: "cached")], cursor: "c0"), for: "k")
    let loader = ConversationLoader<Entry>(key: "k", cache: memory)
    var lifecycle = ConversationFeedLifecycle<Failure>()
    var visible: [Entry] = []
    let show: ConversationLoader<Entry>.Show = { events in
        lifecycle.publish(events) { visible = $0 }
    }
    await loader.showCached(show)
    #expect(visible == [Entry(id: "cached")])
    let gate = Deferred<ConversationPage<Entry>>()
    let pending = Task {
        try await loader.catchUp({ (_: ConversationRead) async throws(Failure) -> ConversationPage<Entry> in
            await gate.value()
        }, show: show)
    }
    for await _ in gate.started { break }
    lifecycle.revoke(.denied) {
        loader.forget()
        visible = []
    }
    gate.release?.resume(returning: ConversationPage(events: [Entry(id: "late")], cursor: "c1", hasMore: false))
    try await pending.value
    #expect(visible.isEmpty)
    #expect(loader.snapshot.events.isEmpty)
    #expect(memory.snapshot(for: "k") == nil)
    #expect(lifecycle.connection == .stopped(.denied))
    #expect(!lifecycle.canKeepHistory(hasPublished: true, hasWindow: true))
}

@MainActor
@Test func deniedOrCancelledRenderingCannotRepopulateErasedPresentation() async {
    for deny in [true, false] {
        var lifecycle = ConversationFeedLifecycle<Failure>()
        var visible = ""
        lifecycle.publish("cached") { visible = $0 }
        let gate = Deferred<String>()
        let rendering = Task {
            let value = await gate.value()
            return lifecycle.publish(value) { visible = $0 }
        }
        for await _ in gate.started { break }
        if deny { lifecycle.revoke(.denied) { visible = "" } }
        else { rendering.cancel() }
        gate.release?.resume(returning: "late rendered Markdown")
        #expect(await rendering.value == false)
        #expect(visible == (deny ? "" : "cached"))
        if deny {
            lifecycle.readSucceeded()
            lifecycle.refreshFailed(.offline, message: "Late failure")
            #expect(!lifecycle.refreshSucceeded())
            #expect(lifecycle.connection == .stopped(.denied))
        }
    }
}
