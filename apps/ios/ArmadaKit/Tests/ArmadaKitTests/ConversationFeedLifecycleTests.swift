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
    let restarted = lifecycle.refreshSucceeded()
    #expect(restarted)
    #expect(lifecycle.connection == .live)
    let redundantRestart = lifecycle.refreshSucceeded()
    #expect(!redundantRestart)
}

@Test func stoppedFollowersStayPausedOnFailedRefreshAndRestartOnlyAfterSuccess() {
    var lifecycle = ConversationFeedLifecycle<Failure>()
    lifecycle.readFailed(.unsupported, retryable: false, message: "Unsupported")
    #expect(lifecycle.connection == .stopped(.unsupported))
    lifecycle.refreshFailed(.offline, message: "Still offline")
    #expect(lifecycle.connection == .stopped(.offline))
    let stoppedRestart = lifecycle.refreshSucceeded()
    #expect(stoppedRestart)
    #expect(lifecycle.connection == .live)
    lifecycle.readFailed(.offline, retryable: true, message: "First failure")
    lifecycle.refreshFailed(.offline, message: "New server reason")
    #expect(lifecycle.connection == .reconnecting("New server reason"))
    let reconnectRestart = lifecycle.refreshSucceeded()
    #expect(reconnectRestart)
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
            let revived = lifecycle.refreshSucceeded()
            #expect(!revived)
            #expect(lifecycle.connection == .stopped(.denied))
        }
    }
}

@MainActor
@Test func retainedFeedReplaysUnchangedHistoryWhenInitialPresentationWasCancelled() async throws {
    // Cover cache restoration and a first server read, cancelled during projection or Markdown.
    for cached in [true, false] {
        for plainTextPublished in [true, false] {
            let memory = ConversationCache<Entry>()
            let events = [Entry(id: "history")]
            if cached {
                memory.store(ConversationSnapshot(events: events, cursor: "c0"), for: "k")
            }
            let loader = ConversationLoader<Entry>(key: "k", cache: memory)
            var lifecycle = ConversationFeedLifecycle<Failure>()
            var visible: [Entry] = []
            var markdown = ""
            let gate = Deferred<Void>()
            let interrupted: ConversationLoader<Entry>.Show = { values in
                if plainTextPublished { lifecycle.publish(values) { visible = $0 } }
                await gate.value()
                lifecycle.publish(values) {
                    visible = $0
                    markdown = "interrupted"
                }
            }
            let initial = Task {
                if cached { _ = await loader.showCached(interrupted) }
                else {
                    try await loader.catchUp({ _ throws(Failure) in
                        ConversationPage(events: events, cursor: "c0", hasMore: false)
                    }, show: interrupted)
                }
            }
            for await _ in gate.started { break }
            initial.cancel()
            // Replay before the cancelled worker returns: navigation can restart immediately.
            let replayed = await loader.showCached { values in
                lifecycle.publish(values) {
                    visible = $0
                    markdown = "complete"
                }
            }
            #expect(replayed)
            #expect(visible == events)
            #expect(markdown == "complete")
            gate.release?.resume(returning: ())
            try await initial.value
            #expect(visible == events)
            #expect(markdown == "complete")
            #expect(loader.hasShown)
            var duplicatePublications = 0
            let repeated = await loader.showCached { _ in duplicatePublications += 1 }
            #expect(!repeated)
            #expect(duplicatePublications == 0)
        }
    }
}
