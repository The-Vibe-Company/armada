import Foundation

/// One read of a conversation's event stream (#812), events in chronological order.
public struct ConversationPage<Event: Sendable>: Sendable {
    public let events: [Event]
    /// Forward continuation after the newest event read: the live frontier.
    public let cursor: String?
    /// Backward reads only: continuation before the oldest event of the page.
    public let olderCursor: String?
    /// Relative to the read's direction: newer events (forward) or older ones (backward).
    public let hasMore: Bool

    public init(events: [Event], cursor: String?, olderCursor: String? = nil, hasMore: Bool) {
        self.events = events
        self.cursor = cursor
        self.olderCursor = olderCursor
        self.hasMore = hasMore
    }
}

/// What one read asks the server for.
public enum ConversationRead: Sendable, Equatable {
    /// The latest page, read backward from the end.
    case latest
    /// The page before an `olderCursor`, read backward.
    case older(String)
    /// The page after the live frontier (from the start when nil), read forward.
    case newer(String?)
}

/// What is known of one conversation: a contiguous window of its events in chronological order,
/// the forward frontier after the newest one and the cursor before the oldest one.
public struct ConversationSnapshot<Event: Identifiable & Equatable & Sendable>: Sendable {
    public fileprivate(set) var events: [Event] = []
    /// Forward frontier. Moved only by the latest read and forward reads, never by older pages.
    public fileprivate(set) var cursor: String?
    public fileprivate(set) var olderCursor: String?
    /// Older events exist before `olderCursor`.
    public fileprivate(set) var hasOlder = false
    /// The latest page was read: the next read continues forward from `cursor`.
    public fileprivate(set) var hasTail = false

    public init() {}

    public init(events: [Event], cursor: String?, olderCursor: String? = nil, hasOlder: Bool = false) {
        self.events = events
        self.cursor = cursor
        self.olderCursor = olderCursor
        self.hasOlder = hasOlder
        hasTail = true
    }
}

/// The last known state of the conversations opened recently, in memory only, so returning to one
/// shows it at once. Bounded by `capacity` (least recently used first out). The app keys entries
/// by resource id and empties the cache when the session or the organization changes. A snapshot
/// is shown before the server rechecks access, so the first refusal removes its entry and hides
/// the conversation.
@MainActor
public final class ConversationCache<Event: Identifiable & Equatable & Sendable> {
    private var entries: [String: ConversationSnapshot<Event>] = [:]
    private var order: [String] = []
    public let capacity: Int

    public init(capacity: Int = 8) {
        self.capacity = max(1, capacity)
    }

    public func snapshot(for key: String) -> ConversationSnapshot<Event>? {
        guard let snapshot = entries[key] else { return nil }
        touch(key)
        return snapshot
    }

    public func store(_ snapshot: ConversationSnapshot<Event>, for key: String) {
        entries[key] = snapshot
        touch(key)
        while order.count > capacity {
            entries[order.removeFirst()] = nil
        }
    }

    public func remove(_ key: String) {
        entries[key] = nil
        order.removeAll { $0 == key }
    }

    public func removeAll() {
        entries = [:]
        order = []
    }

    public var keys: [String] { order }

    private func touch(_ key: String) {
        order.removeAll { $0 == key }
        order.append(key)
    }
}

/// Loads and follows one conversation for display, latest messages first (#812):
/// 1. a snapshot kept from an earlier visit is shown at once, before any request;
/// 2. otherwise the latest page is read backward from the end and shown: the first paint is one read;
/// 3. the stream is then followed forward from the frontier that read returned, back to back while
///    the server reports more, otherwise after the poll delay;
/// 4. older history is read only when asked (`loadOlder`, on scroll-up) and prepended.
/// `show` receives the whole window once per read that changed it (never once per event), and the
/// snapshot is saved to the cache after every change. Reads are idempotent: an event read again
/// replaces its earlier body in place, and only forward reads move the frontier, so older pages and
/// live follow stitch without gap or duplicate.
///
/// A server without backward reads answers the latest read with its first page and no
/// `olderCursor`; its `hasMore` then means newer events, which are followed forward at once.
@MainActor
public final class ConversationLoader<Event: Identifiable & Equatable & Sendable> {
    public typealias Show = @MainActor (_ events: [Event]) async -> Void

    public private(set) var snapshot: ConversationSnapshot<Event>
    /// Something was shown: a cached snapshot or a first read.
    public private(set) var hasShown = false
    public private(set) var isLoadingOlder = false

    private let key: String
    private let cache: ConversationCache<Event>?

    public init(key: String, cache: ConversationCache<Event>?) {
        self.key = key
        self.cache = cache
        snapshot = cache?.snapshot(for: key) ?? ConversationSnapshot()
    }

    public var hasOlder: Bool { snapshot.hasOlder }

    /// Shows a snapshot kept from an earlier visit, without any request. Returns whether one was.
    @discardableResult
    public func showCached(_ show: Show) async -> Bool {
        guard !hasShown, snapshot.hasTail else { return false }
        hasShown = true
        await show(snapshot.events)
        return true
    }

    /// Reads to the newest event now (pull to refresh): the latest page when none was read yet,
    /// then forward pages while the server reports more.
    public func catchUp<Failure: Error>(
        _ fetch: (_ read: ConversationRead) async throws(Failure) -> ConversationPage<Event>,
        show: Show
    ) async throws(Failure) {
        while !Task.isCancelled {
            guard try await step(fetch, show: show) else { return }
        }
    }

    /// Shows the cached snapshot, reads the latest page, then follows forward until the calling
    /// task is cancelled or `onFailure` stops it. `pollDelay` is read whenever the frontier is
    /// reached; after a failure `onFailure` returns the backoff, or nil to stop.
    public func run<C: Clock, Failure: Error>(
        clock: C,
        fetch: (_ read: ConversationRead) async throws(Failure) -> ConversationPage<Event>,
        show: Show,
        pollDelay: @MainActor () -> C.Duration,
        onRead: @MainActor () -> Void = {},
        onFailure: @MainActor (_ failure: Failure, _ consecutive: Int) -> C.Duration?
    ) async {
        await showCached(show)
        var failures = 0
        while !Task.isCancelled {
            do throws(Failure) {
                let more = try await step(fetch, show: show)
                guard !Task.isCancelled else { return }
                failures = 0
                onRead()
                if more { continue }
                try? await clock.sleep(for: pollDelay())
            } catch {
                guard !Task.isCancelled else { return }
                failures += 1
                guard let backoff = onFailure(error, failures) else { return }
                try? await clock.sleep(for: backoff)
            }
        }
    }

    /// Reads the page before the oldest event shown and prepends it. Does nothing when there is
    /// none or one is already being read. The frontier is not moved.
    public func loadOlder<Failure: Error>(
        _ fetch: (_ read: ConversationRead) async throws(Failure) -> ConversationPage<Event>,
        show: Show
    ) async throws(Failure) {
        guard snapshot.hasOlder, let before = snapshot.olderCursor, !isLoadingOlder else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        let page = try await fetch(.older(before))
        // The window may have been replaced meanwhile; only continue from where this read started.
        guard snapshot.olderCursor == before else { return }
        let changed = Self.prepend(page.events, into: &snapshot.events)
        snapshot.olderCursor = page.olderCursor
        snapshot.hasOlder = page.hasMore && page.olderCursor != nil
        cache?.store(snapshot, for: key)
        if changed { await show(snapshot.events) }
    }

    /// Forgets this conversation in memory (for example after a refused read).
    public func forget() {
        cache?.remove(key)
    }

    /// One read toward the newest event. Returns whether newer events remain to read at once.
    private func step<Failure: Error>(
        _ fetch: (_ read: ConversationRead) async throws(Failure) -> ConversationPage<Event>,
        show: Show
    ) async throws(Failure) -> Bool {
        if !snapshot.hasTail {
            let page = try await fetch(.latest)
            guard !snapshot.hasTail else { return false }
            let changed = EventStream.merge(page.events, into: &snapshot.events)
            snapshot.cursor = page.cursor
            snapshot.olderCursor = page.olderCursor
            snapshot.hasOlder = page.hasMore && page.olderCursor != nil
            snapshot.hasTail = true
            await publish(store: true, render: changed, show: show)
            // Without an older cursor, `hasMore` can only mean newer events (a forward-only server).
            return page.hasMore && page.olderCursor == nil && page.cursor != nil
        }
        let previous = snapshot.cursor
        let page = try await fetch(.newer(previous))
        let changed = EventStream.merge(page.events, into: &snapshot.events)
        if let next = page.cursor { snapshot.cursor = next }
        let advanced = snapshot.cursor != previous
        await publish(store: changed || advanced, render: changed, show: show)
        return page.hasMore && advanced
    }

    /// Saves the snapshot when it moved and shows it when its events changed (or nothing was shown).
    private func publish(store: Bool, render: Bool, show: Show) async {
        if store || !hasShown { cache?.store(snapshot, for: key) }
        guard render || !hasShown else { return }
        hasShown = true
        await show(snapshot.events)
    }

    /// Older events go first in their order; an event already known is replaced in place.
    private static func prepend(_ older: [Event], into events: inout [Event]) -> Bool {
        let index = Dictionary(events.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first })
        var fresh: [Event] = []
        var seen = Set<Event.ID>()
        var changed = false
        for event in older where seen.insert(event.id).inserted {
            if let position = index[event.id] {
                if events[position] != event { events[position] = event; changed = true }
            } else {
                fresh.append(event)
            }
        }
        guard !fresh.isEmpty else { return changed }
        events.insert(contentsOf: fresh, at: 0)
        return true
    }
}
