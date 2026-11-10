import class ArmadaKit.ConversationCache
import class ArmadaKit.ConversationLoader
import struct ArmadaKit.ConversationPage
import enum ArmadaKit.ConversationRead
import Foundation
import Observation

/// The conversations opened recently in this session, in memory only (ArmadaKit
/// `ConversationCache`). `AppModel` owns one and empties it when the session or organization changes.
typealias ConversationMemory = ConversationCache<OrchestratorEvent>

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
    enum Connection: Equatable {
        case connecting
        case live
        case reconnecting(String)
        case stopped(ServiceFailure)
    }

    /// One read: forward after `cursor`, or backward (the latest page when `cursor` is nil, else
    /// the page before that older cursor).
    typealias Fetch = @Sendable (_ cursor: String?, _ backward: Bool) async throws(ServiceFailure) -> OrchestratorEventPage

    private(set) var conversation = Conversation(items: [], running: false, technicalCount: 0)
    private(set) var documents: [String: MarkdownDocument] = [:]
    private(set) var connection: Connection = .connecting
    /// Something is shown: this session's earlier read of the conversation, or the latest page.
    private(set) var hasLoaded = false
    /// Older history exists above what is shown.
    private(set) var hasOlder = false
    private(set) var isLoadingOlder = false
    /// Counts older pages read, so the transcript asks again even when a page added no new first
    /// item (more fragments of a message already shown, or only technical events).
    private(set) var olderPagesRead = 0
    /// The highest orchestrator revision any event carried; a newer value means detail is stale.
    private(set) var latestRevision = 0

    @ObservationIgnored private let loader: ConversationLoader<OrchestratorEvent>
    @ObservationIgnored private var cache: [String: CachedMarkdownDocument] = [:]
    /// Orders projections that finish out of order: only the latest stream is shown.
    @ObservationIgnored private var generation = 0

    init(key: String, memory: ConversationMemory?) {
        loader = ConversationLoader(key: key, cache: memory)
    }

    /// Reads what is new now (pull to refresh) up to the newest event. Safe beside `follow`:
    /// events are applied once by id, so overlapping reads change nothing.
    func refresh(_ fetch: @escaping Fetch) async throws(ServiceFailure) {
        await loader.showCached(show)
        try await loader.catchUp(Self.read(fetch), show: show)
    }

    /// Shows what is known, reads the latest page, then follows forward until the calling task is
    /// cancelled (the screen disappears) or the stream stops.
    func follow(_ fetch: @escaping Fetch, onSignedOut: @MainActor () -> Void) async {
        await loader.run(
            clock: ContinuousClock(),
            fetch: Self.read(fetch),
            show: show,
            pollDelay: { self.conversation.running ? .seconds(2) : .seconds(6) },
            onRead: { self.connection = .live },
            onFailure: { (error: ServiceFailure, failures: Int) -> Duration? in
                switch error {
                case .signedOut:
                    onSignedOut()
                    return nil
                case .unavailable, .noAccess, .rejected:
                    self.connection = .stopped(error)
                    return nil
                case .offline, .uncertain, .staleRevision:
                    self.connection = .reconnecting(error.message)
                    return .seconds(min(30, 1 << min(failures, 5)))
                }
            }
        )
    }

    /// Reads the page before the oldest message shown (scroll-up). A failure is returned to the
    /// caller; the next scroll-up tries again.
    func loadOlder(_ fetch: @escaping Fetch) async throws(ServiceFailure) {
        guard loader.hasOlder, !loader.isLoadingOlder else { return }
        isLoadingOlder = true
        defer {
            isLoadingOlder = false
            hasOlder = loader.hasOlder
        }
        try await loader.loadOlder(Self.read(fetch), show: show)
        olderPagesRead += 1
    }

    /// Forgets what this session kept of the conversation, after its access was refused.
    func forget() {
        loader.forget()
    }

    private static func read(
        _ fetch: @escaping Fetch
    ) -> (ConversationRead) async throws(ServiceFailure) -> ConversationPage<OrchestratorEvent> {
        { (read: ConversationRead) async throws(ServiceFailure) -> ConversationPage<OrchestratorEvent> in
            let page: OrchestratorEventPage
            switch read {
            case .latest: page = try await fetch(nil, true)
            case .older(let cursor): page = try await fetch(cursor, true)
            case .newer(let cursor): page = try await fetch(cursor, false)
            }
            return ConversationPage(events: page.events, cursor: page.cursor, olderCursor: page.olderCursor, hasMore: page.hasMore)
        }
    }

    /// Called once per read that changed the stream (never per event). Projection and Markdown
    /// run off the main actor, so a long history never blocks scrolling or the composer.
    private func show(_ events: [OrchestratorEvent]) async {
        hasOlder = loader.hasOlder
        generation += 1
        let current = generation
        let projected = await Task.detached(priority: .userInitiated) {
            ConversationProjection.project(events)
        }.value
        guard current == generation else { return }
        latestRevision = max(latestRevision, events.map(\.revision).max() ?? 0)
        conversation = projected
        hasLoaded = true
        let sources = projected.items.compactMap { item -> MarkdownDocumentSource? in
            guard case .assistant(let text, _, _) = item.kind else { return nil }
            return MarkdownDocumentSource(eventID: item.key, content: text)
        }
        let rendered = await MarkdownDocumentRenderer.render(sources: sources, reusing: cache)
        guard current == generation else { return }
        cache = rendered
        documents = rendered.mapValues(\.document)
    }
}
