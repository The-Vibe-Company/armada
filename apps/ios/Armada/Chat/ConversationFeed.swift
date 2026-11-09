import enum ArmadaKit.EventStream
import Foundation
import Observation

/// Follows one durable event stream by its opaque cursor and keeps the projected conversation.
/// Reads are poll-safe and idempotent: an event read again replaces its earlier body in place (a
/// sandbox prompt that finished, a message that grew), the cursor only moves forward,
/// and a lost connection resumes from the last cursor with backoff. An unavailable capability or a
/// refused access stops the feed explicitly instead of retrying forever.
@MainActor
@Observable
final class ConversationFeed {
    enum Connection: Equatable {
        case connecting
        case live
        case reconnecting(String)
        case stopped(ServiceFailure)
    }

    typealias Fetch = @Sendable (_ cursor: String?) async throws(ServiceFailure) -> OrchestratorEventPage

    private(set) var conversation = Conversation(items: [], running: false, technicalCount: 0)
    private(set) var documents: [String: MarkdownDocument] = [:]
    private(set) var connection: Connection = .connecting
    private(set) var hasLoaded = false
    /// The highest orchestrator revision any event carried; a newer value means detail is stale.
    private(set) var latestRevision = 0

    @ObservationIgnored private var events: [OrchestratorEvent] = []
    @ObservationIgnored private var cursor: String?
    @ObservationIgnored private var cache: [String: CachedMarkdownDocument] = [:]

    /// Seeds the feed with events already read (for example with an interior response).
    func seed(_ initial: [OrchestratorEvent], cursor: String?) async {
        self.cursor = cursor
        await ingest(initial)
        hasLoaded = true
    }

    /// Reads what is new now (pull to refresh), page by page from the current cursor. Safe beside
    /// `follow`: events are applied once by id, so overlapping reads change nothing.
    func refresh(_ fetch: Fetch) async throws(ServiceFailure) {
        while !Task.isCancelled {
            let previous = cursor
            let page = try await fetch(cursor)
            if let next = page.cursor { cursor = next }
            await ingest(page.events)
            hasLoaded = true
            guard page.hasMore, cursor != previous else { return }
        }
    }

    /// Runs until the calling task is cancelled (the screen disappears) or the stream stops.
    func follow(_ fetch: Fetch, onSignedOut: @MainActor () -> Void) async {
        var failures = 0
        while !Task.isCancelled {
            do throws(ServiceFailure) {
                let previous = cursor
                let page = try await fetch(cursor)
                guard !Task.isCancelled else { return }
                if let next = page.cursor { cursor = next }
                // Only read again at once when the cursor moved; otherwise poll normally.
                let advanced = cursor != previous
                await ingest(page.events)
                hasLoaded = true
                connection = .live
                failures = 0
                if page.hasMore, advanced { continue }
                try? await Task.sleep(for: conversation.running ? .seconds(2) : .seconds(6))
            } catch {
                // Leaving the screen cancels the read; that is not a lost connection.
                guard !Task.isCancelled else { return }
                switch error {
                case .signedOut:
                    onSignedOut()
                    return
                case .unavailable, .noAccess, .rejected:
                    connection = .stopped(error)
                    return
                case .offline, .uncertain, .staleRevision:
                    failures += 1
                    connection = .reconnecting(error.message)
                    try? await Task.sleep(for: .seconds(min(30, 1 << min(failures, 5))))
                }
            }
        }
    }

    private func ingest(_ incoming: [OrchestratorEvent]) async {
        let changed = EventStream.merge(incoming, into: &events)
        guard changed || !hasLoaded else { return }
        latestRevision = max(latestRevision, incoming.map(\.revision).max() ?? 0)
        conversation = ConversationProjection.project(events)
        let sources = conversation.items.compactMap { item -> MarkdownDocumentSource? in
            guard case .assistant(let text, _, _) = item.kind else { return nil }
            return MarkdownDocumentSource(eventID: item.key, content: text)
        }
        let rendered = await MarkdownDocumentRenderer.render(sources: sources, reusing: cache)
        cache = rendered
        documents = rendered.mapValues(\.document)
    }
}
