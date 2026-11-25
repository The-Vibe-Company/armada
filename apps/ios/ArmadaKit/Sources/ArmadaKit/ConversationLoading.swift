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
    fileprivate var liveOnly: [UInt64?] = []

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
    private var states: [String: any Sendable] = [:]
    private var order: [String] = []
    private var presentations: [String: any Sendable] = [:]
    private var versions: [String: UUID] = [:]
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
        if entries[key]?.events != snapshot.events {
            presentations[key] = nil
            versions[key] = UUID()
        }
        entries[key] = snapshot
        touch(key)
        while order.count > capacity {
            remove(order[0])
        }
    }

    /// Reads or stores an auxiliary state value sharing the snapshot's LRU and invalidation lifetime.
    public func state<State: Sendable>(for key: String, as _: State.Type = State.self) -> State? {
        guard let value = states[key] as? State else { return nil }
        touch(key)
        return value
    }

    public func storeState<State: Sendable>(_ state: State, for key: String) {
        states[key] = state
        touch(key)
        while order.count > capacity { remove(order[0]) }
    }

    public func remove(_ key: String) {
        entries[key] = nil
        states[key] = nil
        presentations[key] = nil
        versions[key] = nil
        order.removeAll { $0 == key }
    }

    public func removeAll() {
        entries = [:]
        states = [:]
        presentations = [:]
        versions = [:]
        order = []
    }

    /// Synchronous lookup for an already-built presentation matching the exact cached event window.
    public func cachedPresentation<Content: Sendable>(for key: String, events: [Event]) -> Content? {
        guard entries[key]?.events == events, let existing = presentations[key] as? Content else { return nil }
        touch(key)
        return existing
    }

    /// Reuses a derived presentation only for the exact event window still held by this cache.
    /// Cursor-only progress does not rebuild it. Payloads share the snapshot's LRU and privacy
    /// lifetime; an evicted/forgotten entry cannot be recreated by late asynchronous rendering.
    public func rendered<Content: Sendable>(
        for key: String,
        events: [Event],
        build: @MainActor ([Event]) async -> Content
    ) async -> Content {
        if let existing: Content = cachedPresentation(for: key, events: events) {
            return existing
        }
        let version = versions[key]
        let value = await build(events)
        if !Task.isCancelled, let version, versions[key] == version, entries[key]?.events == events {
            presentations[key] = value
        }
        return value
    }

    public var keys: [String] { order }

    private func touch(_ key: String) {
        order.removeAll { $0 == key }
        order.append(key)
    }
}

/// Bounded retry backoff for transient `logs/read` 400/409 rejections while a sandbox is starting.
public enum ConversationFollowBackoff {
    public static let maxStartingRejectionRetries = 20

    public static func startingRejection(consecutiveFailures: Int, isStarting: Bool) -> Duration? {
        guard isStarting, (1...maxStartingRejectionRetries).contains(consecutiveFailures) else { return nil }
        return .seconds(min(15, 1 << min(consecutiveFailures, 4)))
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
    private var revision = 0
    private var newestRevision = 0
    private var forgotten = false, liveConnected = false, wakePending = false
    private var sleepContinuation: CheckedContinuation<Void, Never>? = nil, sleepTimer: Task<Void, Never>? = nil
    private var sleepToken: UInt64 = 0

    public init(key: String, cache: ConversationCache<Event>?) {
        self.key = key
        self.cache = cache
        snapshot = cache?.snapshot(for: key) ?? ConversationSnapshot()
    }

    public var hasOlder: Bool { snapshot.hasOlder }

    /// Shows a snapshot kept from an earlier visit, without any request. Returns whether one was.
    @discardableResult
    public func showCached(_ show: Show) async -> Bool {
        guard !forgotten, !hasShown, snapshot.hasTail else { return false }
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
        while !Task.isCancelled, !forgotten {
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
        while !Task.isCancelled, !forgotten {
            do throws(Failure) {
                let more = try await step(fetch, show: show)
                guard !Task.isCancelled, !forgotten else { return }
                failures = 0
                onRead()
                if more { continue }
                await waitForNextPoll(clock: clock, delay: pollDelay())
            } catch {
                guard !Task.isCancelled, !forgotten else { return }
                failures += 1
                guard let backoff = onFailure(error, failures) else { return }
                try? await clock.sleep(for: backoff)
            }
        }
    }

    public func wake() {
        guard !forgotten, !liveConnected else { return }
        if sleepContinuation != nil { resumeSleep() } else { wakePending = true }
    }
    public func setLiveConnected(_ connected: Bool) {
        guard !forgotten, liveConnected != connected else { return }
        liveConnected = connected
        if connected { wakePending = false; sleepTimer?.cancel(); sleepTimer = nil } else { wake() }
    }
    public func applyLiveEvent(_ event: Event, sequence: String? = nil, show: Show) async {
        guard !forgotten, !Task.isCancelled else { return }
        let seq = sequence.flatMap(UInt64.init)
        if let seq, let cur = Self.cursorSequence(snapshot.cursor), seq <= cur { return }
        let existingIndex = snapshot.events.firstIndex { $0.id == event.id }
        revision += 1; newestRevision += 1
        let changed = EventStream.merge([event], into: &snapshot.events)
        if let idx = existingIndex {
            let base = snapshot.events.count - snapshot.liveOnly.count
            if idx >= base, let seq { snapshot.liveOnly[idx - base] = max(snapshot.liveOnly[idx - base] ?? 0, seq) }
        } else { snapshot.liveOnly.append(seq) }
        await publish(store: changed, render: changed, show: show)
    }
    private static func cursorSequence(_ cursor: String?) -> UInt64? {
        guard let cursor, cursor.hasPrefix("ar1_"), let sep = cursor.lastIndex(of: "_") else { return nil }; return UInt64(cursor[cursor.index(after: sep)...])
    }

    /// Reads the page before the oldest event shown and prepends it. Does nothing when there is
    /// none or one is already being read. The frontier is not moved.
    public func loadOlder<Failure: Error>(
        _ fetch: (_ read: ConversationRead) async throws(Failure) -> ConversationPage<Event>,
        show: Show
    ) async throws(Failure) {
        guard !forgotten, !Task.isCancelled, snapshot.hasOlder, let before = snapshot.olderCursor, !isLoadingOlder else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        let startedAt = revision
        let beforeEvents = snapshot.events
        let page = try await fetch(.older(before))
        // The window may have been replaced meanwhile; only continue from where this read started.
        guard !forgotten, !Task.isCancelled, snapshot.olderCursor == before else { return }
        // A live read may have updated overlapping event bodies while this older page waited.
        let incoming = revision == startedAt ? page.events
            : Self.uncontested(page.events, since: beforeEvents, current: snapshot.events)
        let changed = Self.prepend(incoming, into: &snapshot.events)
        revision += 1
        snapshot.olderCursor = page.olderCursor
        snapshot.hasOlder = page.hasMore && page.olderCursor != nil
        cache?.store(snapshot, for: key)
        if changed { await show(snapshot.events) }
    }

    /// Terminal for this loader (for example after a refused read). A new authorized screen
    /// creates a new loader; late reads may not restore this window or restart its polling.
    public func forget() {
        forgotten = true; revision += 1; liveConnected = false; wakePending = false
        resumeSleep(); snapshot = ConversationSnapshot(); hasShown = false; cache?.remove(key)
    }

    private func waitForNextPoll<C: Clock>(clock: C, delay: C.Duration) async {
        guard !forgotten, !Task.isCancelled else { return }
        if !liveConnected, wakePending { wakePending = false; return }
        sleepToken &+= 1; let token = sleepToken
        await withTaskCancellationHandler {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                if Task.isCancelled || forgotten || (!liveConnected && wakePending) {
                    if !liveConnected { wakePending = false }; c.resume(); return
                }
                sleepContinuation = c
                guard !liveConnected else { return }
                sleepTimer = Task { @MainActor [weak self] in
                    try? await clock.sleep(for: delay)
                    guard let self, self.sleepToken == token, !Task.isCancelled, !self.liveConnected else { return }
                    self.resumeSleep(token: token)
                }
            }
        } onCancel: { Task { @MainActor [weak self] in self?.resumeSleep(token: token) } }
        sleepToken &+= 1; sleepTimer?.cancel(); sleepTimer = nil
    }
    private func resumeSleep(token: UInt64? = nil) {
        if let token, sleepToken != token { return }
        sleepTimer?.cancel(); sleepTimer = nil
        if let c = sleepContinuation { sleepContinuation = nil; c.resume() }
    }

    /// One read toward the newest event. Returns whether another immediate read is needed
    /// for newer events or to revalidate a contested response without skipping its frontier.
    private func step<Failure: Error>(
        _ fetch: (_ read: ConversationRead) async throws(Failure) -> ConversationPage<Event>,
        show: Show
    ) async throws(Failure) -> Bool {
        guard !forgotten, !Task.isCancelled else { return false }
        let startedAt = revision
        let newestAt = newestRevision
        if !snapshot.hasTail {
            let page = try await fetch(.latest)
            guard !forgotten, !Task.isCancelled, revision == startedAt, !snapshot.hasTail else { return false }
            revision += 1
            newestRevision += 1
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
        let beforeEvents = snapshot.events
        let page = try await fetch(.newer(previous))
        // Another forward read won: its frontier/body is newer than this request's window.
        guard !forgotten, !Task.isCancelled, newestRevision == newestAt else { return false }
        // Pagination may have changed the window without advancing the live frontier.
        let incoming = revision == startedAt ? page.events
            : Self.uncontested(page.events, since: beforeEvents, current: snapshot.events)
        // An older page may contain only intermediate content. Never commit a frontier while
        // suppressing a conflicting live body: revalidate the whole page from the same cursor.
        // If that read fails, the existing frontier still permits a later retry of the update.
        guard incoming.count == page.events.count else { return true }
        revision += 1; newestRevision += 1
        let advanced = page.cursor != nil && page.cursor != previous; let changed: Bool
        if advanced, !snapshot.liveOnly.isEmpty {
            let before = snapshot.events; let n = min(snapshot.liveOnly.count, snapshot.events.count)
            let tail = Array(zip(snapshot.events.suffix(n), snapshot.liveOnly.suffix(n)))
            snapshot.events.removeLast(n); snapshot.liveOnly.removeAll(); _ = EventStream.merge(incoming, into: &snapshot.events)
            if page.hasMore, let nextCur = Self.cursorSequence(page.cursor) {
                for (ev, seq) in tail where (seq ?? 0) > nextCur {
                    if !snapshot.events.contains(where: { $0.id == ev.id }) { snapshot.liveOnly.append(seq) }
                    _ = EventStream.merge([ev], into: &snapshot.events)
                }
            }
            changed = snapshot.events != before
        } else { changed = EventStream.merge(incoming, into: &snapshot.events) }
        if let next = page.cursor { snapshot.cursor = next }
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

    /// Only protect bodies actually changed while a read waited. Unchanged overlaps may still
    /// carry useful updates, and fresh IDs must not be lost when pagination and live reads race.
    private static func uncontested(_ incoming: [Event], since before: [Event], current: [Event]) -> [Event] {
        let previous = Dictionary(before.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let known = Dictionary(current.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return incoming.filter { event in
            guard let existing = known[event.id] else { return true }
            return event == existing || previous[event.id] == existing
        }
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
