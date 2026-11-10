import class ArmadaKit.ConversationCache
import class ArmadaKit.ConversationLoader
import struct ArmadaKit.ConversationPage
import enum ArmadaKit.ConversationRead
import Foundation
import Observation

/// The conversations opened recently in this session, in memory only (ArmadaKit
/// `ConversationCache`). `AppModel` owns one and empties it when the session or organization changes.
typealias ConversationMemory = ConversationCache<OrchestratorEvent>

/// Follows one durable event stream by its opaque cursor and keeps the projected conversation.
/// The loading order is ArmadaKit's `ConversationLoader`: what this session already read is shown
/// at once, otherwise the first page is shown as soon as it arrives and the rest of the history is
/// read with catch-up reads before polling starts. Reads are poll-safe and idempotent: an event
/// read again replaces its earlier body in place (a sandbox prompt that finished, a message that
/// grew), and a lost connection resumes from the last cursor with backoff. An unavailable
/// capability or a refused access stops the feed explicitly instead of retrying forever.
@MainActor
@Observable
final class ConversationFeed {
    enum Connection: Equatable {
        case connecting
        case live
        case reconnecting(String)
        case stopped(ServiceFailure)
    }

    /// One read from `cursor`; `catchUp` asks the server for as much as one response may carry.
    typealias Fetch = @Sendable (_ cursor: String?, _ catchUp: Bool) async throws(ServiceFailure) -> OrchestratorEventPage

    private(set) var conversation = Conversation(items: [], running: false, technicalCount: 0)
    private(set) var documents: [String: MarkdownDocument] = [:]
    private(set) var connection: Connection = .connecting
    /// Something is shown: this session's earlier read of the conversation, or a first page.
    private(set) var hasLoaded = false
    /// The highest orchestrator revision any event carried; a newer value means detail is stale.
    private(set) var latestRevision = 0

    @ObservationIgnored private let loader: ConversationLoader<OrchestratorEvent>
    @ObservationIgnored private var cache: [String: CachedMarkdownDocument] = [:]
    /// Orders projections that finish out of order: only the latest stream is shown.
    @ObservationIgnored private var generation = 0

    init(key: String, memory: ConversationMemory?) {
        loader = ConversationLoader(key: key, cache: memory)
    }

    /// Reads what is new now (pull to refresh) from the current cursor to the server's end. Safe
    /// beside `follow`: events are applied once by id, so overlapping reads change nothing.
    func refresh(_ fetch: @escaping Fetch) async throws(ServiceFailure) {
        await loader.showCached(show)
        try await loader.catchUp(Self.read(fetch), show: show)
    }

    /// Shows what is known, catches up, then polls until the calling task is cancelled (the screen
    /// disappears) or the stream stops.
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

    /// Forgets what this session kept of the conversation, after its access was refused.
    func forget() {
        loader.forget()
    }

    private static func read(
        _ fetch: @escaping Fetch
    ) -> (String?, ConversationRead) async throws(ServiceFailure) -> ConversationPage<OrchestratorEvent> {
        { (cursor: String?, read: ConversationRead) async throws(ServiceFailure) -> ConversationPage<OrchestratorEvent> in
            let page = try await fetch(cursor, read == .catchUp)
            return ConversationPage(events: page.events, cursor: page.cursor, hasMore: page.hasMore)
        }
    }

    /// Called once per read that changed the stream (never per event). Projection and Markdown
    /// run off the main actor, so a long history never blocks scrolling or the composer.
    private func show(_ events: [OrchestratorEvent]) async {
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
