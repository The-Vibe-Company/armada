import class ArmadaKit.ConversationCache
import enum ArmadaKit.ConversationFollowBackoff
import class ArmadaKit.ConversationLoader
import struct ArmadaKit.ConversationPage
import enum ArmadaKit.ConversationRead
import Foundation
import Observation
import os

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
    enum Connection: Equatable {
        case connecting
        case live
        case reconnecting(String)
        case stopped(ServiceFailure)
    }

    /// One read: forward after `cursor`, or backward (the latest page when `cursor` is nil, else
    /// the page before that older cursor).
    typealias Fetch = @Sendable (_ cursor: String?, _ backward: Bool) async throws(ServiceFailure) -> ConversationEventPage
    typealias Stream = @Sendable (_ lastEventID: String?) -> AsyncThrowingStream<ConversationStreamEvent, Error>

    private(set) var conversation = Conversation(items: [], activeTurns: [:], technicalCount: 0)
    private(set) var documents: [String: MarkdownDocument] = [:]
    private(set) var connection: Connection = .connecting
    private(set) var isSSEConnected = false
    /// Something is shown: this session's earlier read of the conversation, or the latest page.
    private(set) var hasLoaded = false
    /// Older history exists above what is shown.
    private(set) var hasOlder = false
    private(set) var isLoadingOlder = false
    /// Counts older pages read, so the transcript asks again even when a page added no new first
    /// item (more fragments of a message already shown, or only technical events).
    private(set) var olderPagesRead = 0

    private struct Presentation: Sendable {
        let conversation: Conversation
        let markdown: [String: CachedMarkdownDocument]
    }

    private static let signposter = OSSignposter(subsystem: "co.thevibecompany.armada", category: "ConversationPresentation")
    @ObservationIgnored private let key: String
    @ObservationIgnored private let memory: ConversationMemory?
    @ObservationIgnored private let loader: ConversationLoader<AgentEvent>
    @ObservationIgnored private var cache: [String: CachedMarkdownDocument] = [:]
    /// Orders projections that finish out of order: only the latest stream is shown.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var sseTask: Task<Void, Never>?
    @ObservationIgnored private var sseGeneration = 0
    /// Last committed SSE frame id, preserved across background/foreground reconnects so `Last-Event-ID` resumes without re-reading the tail.
    @ObservationIgnored private var lastEventID: String?

    init(key: String, memory: ConversationMemory?) {
        self.key = key
        self.memory = memory
        loader = ConversationLoader(key: key, cache: memory)
        if loader.snapshot.hasTail,
           let cached: Presentation = memory?.cachedPresentation(for: key, events: loader.snapshot.events) {
            conversation = cached.conversation
            cache = cached.markdown
            documents = cached.markdown.mapValues(\.document)
            hasLoaded = true
            hasOlder = loader.hasOlder
        }
    }

    /// Reads what is new now (pull to refresh) up to the newest event. Safe beside `follow`:
    /// events are applied once by id, so overlapping reads change nothing.
    func refresh(_ fetch: @escaping Fetch) async throws(ServiceFailure) {
        await loader.showCached(show)
        try await loader.catchUp(Self.read(fetch), show: show)
    }

    /// Wakes fallback polling immediately (for example after send, steer, or interrupt).
    func wake() { loader.wake() }

    /// Clears transient reconnect state so returning to the foreground reconnects immediately
    /// without keeping a stale reconnect banner from before backgrounding.
    func resetForForeground() {
        if case .reconnecting = connection { connection = .connecting }
    }

    /// Shows what is known, reads the latest page, then follows via live SSE when available with
    /// automatic fallback to polling on error or disconnect.
    func follow(
        _ fetch: @escaping Fetch, stream: Stream? = nil,
        isStarting: @MainActor @escaping () -> Bool = { false },
        onTransition: @MainActor @escaping (_ status: SandboxStatus?, _ statusReason: String?) -> Void = { _, _ in },
        onSignedOut: @MainActor @escaping () -> Void
    ) async {
        defer { stopSSE() }
        await loader.run(
            clock: ContinuousClock(),
            fetch: Self.read(fetch),
            show: show,
            pollDelay: { self.conversation.running ? .seconds(2) : .seconds(6) },
            onRead: {
                self.connection = .live
                guard self.sseTask == nil, let stream else { return }
                self.sseGeneration &+= 1
                let currentSSE = self.sseGeneration
                self.sseTask = Task { @MainActor [weak self] in
                    await self?.runSSE(generation: currentSSE, stream: stream, fetch: fetch, onTransition: onTransition, onSignedOut: onSignedOut)
                }
            },
            onFailure: { (error: ServiceFailure, failures: Int) -> Duration? in
                switch error.category {
                case .signedOut:
                    onSignedOut()
                    return nil
                case .rejected where error.isTransientWhileStarting:
                    if let backoff = ConversationFollowBackoff.startingRejection(consecutiveFailures: failures, isStarting: isStarting()) {
                        self.connection = .connecting
                        return backoff
                    }
                    self.connection = .stopped(error)
                    return nil
                case .unavailable, .noAccess, .rejected:
                    self.connection = .stopped(error)
                    return nil
                case .offline, .uncertain:
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
        stopSSE()
        lastEventID = nil
        loader.forget()
    }

    private func stopSSE() {
        sseGeneration &+= 1
        sseTask?.cancel()
        sseTask = nil
        setSSEConnected(false)
    }

    private func setSSEConnected(_ connected: Bool) {
        if isSSEConnected != connected { isSSEConnected = connected }; loader.setLiveConnected(connected)
    }

    private func runSSE(
        generation: Int,
        stream: @escaping Stream, fetch: @escaping Fetch,
        onTransition: @MainActor @escaping (_ status: SandboxStatus?, _ statusReason: String?) -> Void,
        onSignedOut: @MainActor @escaping () -> Void
    ) async {
        var failures = 0
        while !Task.isCancelled, sseGeneration == generation {
            var opened = false
            do {
                for try await item in stream(lastEventID) {
                    guard !Task.isCancelled, sseGeneration == generation else { return }
                    let needsGap = lastEventID == nil && !opened; opened = true; failures = 0
                    switch item {
                    case .connected: setSSEConnected(true); connection = .live; if needsGap { try? await loader.catchUp(Self.read(fetch), show: show) }
                    case .event(let id, let seq, let event): lastEventID = id; await loader.applyLiveEvent(event, sequence: seq, show: show)
                    case .transition(let id, let status, let reason): lastEventID = id; onTransition(status, reason)
                    case .advance(let id): lastEventID = id
                    }
                }
            } catch is CancellationError { if sseGeneration == generation { setSSEConnected(false) }; return } catch {
                if sseGeneration == generation { setSSEConnected(false) }
                guard !Task.isCancelled, sseGeneration == generation else { return }
                if let f = error as? ServiceFailure {
                    if f.category == .signedOut { onSignedOut(); return }
                    if [.noAccess, .unavailable, .rejected].contains(f.category) { return }
                }
                failures += 1; try? await Task.sleep(for: .seconds(min(30, 1 << min(failures, 5)))); continue
            }
            if sseGeneration == generation { setSSEConnected(false) }
            guard !Task.isCancelled, sseGeneration == generation else { return }
            if !opened { failures += 1 }; try? await Task.sleep(for: opened ? .seconds(1) : .seconds(min(30, 1 << min(failures, 5))))
        }
    }

    private static func read(
        _ fetch: @escaping Fetch
    ) -> (ConversationRead) async throws(ServiceFailure) -> ConversationPage<AgentEvent> {
        { (read: ConversationRead) async throws(ServiceFailure) -> ConversationPage<AgentEvent> in
            let page: ConversationEventPage
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
    private func show(_ events: [AgentEvent]) async {
        hasOlder = loader.hasOlder
        generation += 1
        let current = generation
        let interval = Self.signposter.beginInterval("Presentation", id: Self.signposter.makeSignpostID())
        defer { Self.signposter.endInterval("Presentation", interval) }
        var rebuilt = false
        let reusedMarkdown = cache
        let build: @MainActor ([AgentEvent]) async -> Presentation = { events in
            rebuilt = true
            let projection = Self.signposter.beginInterval("Projection", id: Self.signposter.makeSignpostID())
            let projected = await Task.detached(priority: .userInitiated) {
                ConversationProjection.project(events)
            }.value
            Self.signposter.endInterval("Projection", projection)
            // Preserve the cold-open first paint: plain text is visible before Markdown finishes.
            if !Task.isCancelled, current == self.generation {
                self.conversation = projected
                self.hasLoaded = true
            }
            let sources = projected.items.compactMap { item -> MarkdownDocumentSource? in
                guard case .assistant(let text, _, _) = item.kind else { return nil }
                return MarkdownDocumentSource(eventID: item.key, content: text)
            }
            let markdown = Self.signposter.beginInterval("Markdown", id: Self.signposter.makeSignpostID())
            let rendered = await MarkdownDocumentRenderer.render(sources: sources, reusing: reusedMarkdown)
            Self.signposter.endInterval("Markdown", markdown)
            return Presentation(conversation: projected, markdown: rendered)
        }
        let presentation: Presentation
        if let memory {
            presentation = await memory.rendered(for: key, events: events, build: build)
        } else {
            presentation = await build(events)
        }
        guard !Task.isCancelled, current == generation else { return }
        if !rebuilt {
            conversation = presentation.conversation
            hasLoaded = true
        }
        cache = presentation.markdown
        documents = presentation.markdown.mapValues(\.document)
    }
}
