import struct ArmadaKit.ConversationFeedLifecycle
import class ArmadaKit.ConversationCache
import class ArmadaKit.ConversationLoader
import struct ArmadaKit.ConversationPage
import enum ArmadaKit.ConversationRead
import Foundation
import Observation

/// The conversations opened recently in this session, in memory only (ArmadaKit
/// `ConversationCache`). `AppModel` owns one and empties it when the session or organization changes.
typealias ConversationMemory = ConversationCache<AgentEvent>

/// Follows one durable event stream and keeps the projected conversation. The loading order is
/// ArmadaKit's `ConversationLoader` (#812): what this session already read is shown at once,
/// otherwise the latest page is read from the end and shown; the stream is then followed forward
/// from that page's frontier, and older history is read only on scroll-up. Reads are poll-safe and
/// idempotent: an event read again replaces its earlier body in place (a sandbox prompt that
/// finished, a message that grew), and a lost connection resumes from the frontier with backoff.
/// An unavailable capability or a refused access stops the feed explicitly instead of retrying.
@MainActor
@Observable
final class ConversationFeed {
    typealias Connection = ConversationFeedLifecycle<ServiceFailure>.Connection

    /// One read: forward after `cursor`, or backward (the latest page when `cursor` is nil, else
    /// the page before that older cursor).
    typealias Fetch = @Sendable (_ cursor: String?, _ backward: Bool) async throws(ServiceFailure) -> ConversationEventPage

    private(set) var conversation = Conversation(items: [], activeTurns: [:], technicalCount: 0)
    private(set) var documents: [String: MarkdownDocument] = [:]
    private var lifecycle = ConversationFeedLifecycle<ServiceFailure>()
    var connection: Connection { lifecycle.connection }
    /// Something is shown: this session's earlier read of the conversation, or the latest page.
    private(set) var hasLoaded = false
    /// Available before asynchronous projection first publishes: an offline detail failure
    /// must not remove the transcript task before it can show this cached window.
    var hasCachedHistory: Bool {
        lifecycle.canKeepHistory(hasPublished: hasLoaded, hasWindow: loader.snapshot.hasTail)
    }
    /// Older history exists above what is shown.
    private(set) var hasOlder = false
    private(set) var isLoadingOlder = false
    /// Counts older pages read, so the transcript asks again even when a page added no new first
    /// item (more fragments of a message already shown, or only technical events).
    private(set) var olderPagesRead = 0

    @ObservationIgnored private let loader: ConversationLoader<AgentEvent>
    @ObservationIgnored private var cache: [String: CachedMarkdownDocument] = [:]
    /// Orders projections that finish out of order: only the latest stream is shown.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var lifetime = 0

    init(key: String, memory: ConversationMemory?) {
        loader = ConversationLoader(key: key, cache: memory)
    }

    /// Reads what is new now (pull to refresh) up to the newest event. Safe beside `follow`:
    /// events are applied once by id, so overlapping reads change nothing. Returns whether
    /// the caller should restart follow after recovering a stopped/backing-off stream.
    func refresh(_ fetch: @escaping Fetch) async throws(ServiceFailure) -> Bool {
        guard !lifecycle.isRevoked else { return false }
        let startedAt = lifetime
        await loader.showCached(show)
        do throws(ServiceFailure) {
            try await loader.catchUp(read(fetch), show: show)
        } catch {
            if !Task.isCancelled, lifetime == startedAt {
                switch error.category {
                case .offline, .uncertain:
                    lifecycle.refreshFailed(error, message: error.message)
                default: break
                }
            }
            throw error
        }
        guard !Task.isCancelled, lifetime == startedAt, loader.snapshot.hasTail else { return false }
        return lifecycle.refreshSucceeded()
    }

    /// Shows what is known, reads the latest page, then follows forward until the calling task is
    /// cancelled (the screen disappears) or the stream stops.
    func follow(_ fetch: @escaping Fetch, onSignedOut: @MainActor () -> Void) async {
        guard !lifecycle.isRevoked else { return }
        await loader.run(
            clock: ContinuousClock(),
            fetch: read(fetch),
            show: show,
            pollDelay: { self.conversation.running ? .seconds(2) : .seconds(6) },
            onRead: { self.lifecycle.readSucceeded() },
            onFailure: { (error: ServiceFailure, failures: Int) -> Duration? in
                switch error.category {
                case .signedOut:
                    onSignedOut()
                    return nil
                case .unavailable, .noAccess, .rejected:
                    self.lifecycle.readFailed(error, retryable: false, message: error.message)
                    return nil
                case .offline, .uncertain:
                    guard !self.lifecycle.isRevoked else { return nil }
                    self.lifecycle.readFailed(error, retryable: true, message: error.message)
                    return .seconds(min(30, 1 << min(failures, 5)))
                }
            }
        )
    }

    /// Reads the page before the oldest message shown (scroll-up). A failure is returned to the
    /// caller; the next scroll-up tries again.
    func loadOlder(_ fetch: @escaping Fetch) async throws(ServiceFailure) {
        guard !lifecycle.isRevoked, loader.hasOlder, !loader.isLoadingOlder else { return }
        isLoadingOlder = true
        let startedAt = lifetime
        defer {
            isLoadingOlder = false
            if lifetime == startedAt { hasOlder = loader.hasOlder }
        }
        try await loader.loadOlder(read(fetch), show: show)
        if !Task.isCancelled, lifetime == startedAt { olderPagesRead += 1 }
    }

    /// Forgets what this session kept of the conversation, after its access was refused.
    func forget(reason: ServiceFailure = .noAccess) {
        lifecycle.revoke(reason) {
            generation += 1
            lifetime += 1
            loader.forget()
            conversation = Conversation(items: [], activeTurns: [:], technicalCount: 0)
            documents = [:]
            cache = [:]
            hasLoaded = false
            hasOlder = false
            isLoadingOlder = false
            olderPagesRead = 0
        }
    }

    private func read(
        _ fetch: @escaping Fetch
    ) -> @MainActor (ConversationRead) async throws(ServiceFailure) -> ConversationPage<AgentEvent> {
        { (read: ConversationRead) async throws(ServiceFailure) -> ConversationPage<AgentEvent> in
            guard !self.lifecycle.isRevoked else { throw .noAccess }
            do throws(ServiceFailure) {
                let page: ConversationEventPage
                switch read {
                case .latest: page = try await fetch(nil, true)
                case .older(let cursor): page = try await fetch(cursor, true)
                case .newer(let cursor): page = try await fetch(cursor, false)
                }
                guard !self.lifecycle.isRevoked else { throw .noAccess }
                return ConversationPage(events: page.events, cursor: page.cursor, olderCursor: page.olderCursor, hasMore: page.hasMore)
            } catch {
                if case .noAccess = error.category { self.forget(reason: error) }
                throw error
            }
        }
    }

    /// Called once per read that changed the stream (never per event). Projection and Markdown
    /// run off the main actor, so a long history never blocks scrolling or the composer.
    private func show(_ events: [AgentEvent]) async {
        guard !lifecycle.isRevoked, !Task.isCancelled else { return }
        hasOlder = loader.hasOlder
        generation += 1
        let current = generation
        let projected = await Task.detached(priority: .userInitiated) {
            ConversationProjection.project(events)
        }.value
        guard current == generation else { return }
        guard lifecycle.publish(projected, apply: {
            conversation = $0
            hasLoaded = true
        }) else { return }
        let sources = projected.items.compactMap { item -> MarkdownDocumentSource? in
            guard case .assistant(let text, _, _) = item.kind else { return nil }
            return MarkdownDocumentSource(eventID: item.key, content: text)
        }
        let rendered = await MarkdownDocumentRenderer.render(sources: sources, reusing: cache)
        guard current == generation else { return }
        lifecycle.publish(rendered) {
            cache = $0
            documents = $0.mapValues(\.document)
        }
    }
}
