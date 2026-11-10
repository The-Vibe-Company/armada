import Foundation

/// One read of a conversation's event stream, oldest first, with the opaque cursor after it.
public struct ConversationPage<Event: Sendable>: Sendable {
    public let events: [Event]
    public let cursor: String?
    public let hasMore: Bool

    public init(events: [Event], cursor: String?, hasMore: Bool) {
        self.events = events
        self.cursor = cursor
        self.hasMore = hasMore
    }
}

/// How much one read asks the server for.
public enum ConversationRead: Sendable, Equatable {
    /// One ordinary page. A conversation's first paint never waits for more than this.
    case page
    /// As much history as one response may carry (`logs/read` with `all`, the largest orchestrator
    /// page), so the rest of a long conversation costs one round trip instead of one per page.
    case catchUp
}

/// What is known of one conversation: its events in server order and the cursor after them.
public struct ConversationSnapshot<Event: Identifiable & Equatable & Sendable>: Sendable {
    public fileprivate(set) var events: [Event] = []
    public fileprivate(set) var cursor: String?

    public init() {}

    public init(events: [Event], cursor: String?) {
        self.events = events
        self.cursor = cursor
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

/// Loads and follows one conversation for display, in the order that shows something soonest:
/// 1. a snapshot kept from an earlier visit is shown at once, before any request;
/// 2. otherwise one ordinary page is read and shown: the first paint never waits for more;
/// 3. while the server reports more, the rest is read with catch-up reads, back to back, never
///    behind a poll delay;
/// 4. then the stream is polled from its cursor.
/// `show` receives the whole stream once per read that changed it (never once per event), and the
/// snapshot is saved to the cache after every change. Reads are idempotent: an event read again
/// replaces its earlier body in place (`EventStream.merge`), and the cursor never moves back to nil.
@MainActor
public final class ConversationLoader<Event: Identifiable & Equatable & Sendable> {
    public typealias Show = @MainActor (_ events: [Event]) async -> Void

    public private(set) var snapshot: ConversationSnapshot<Event>
    /// Something was shown: a cached snapshot or a first read.
    public private(set) var hasShown = false
    /// The last read reached the server's end of the stream.
    public private(set) var isCaughtUp = false
    /// A catch-up read failed (for example it outlasted the timeout): this loader reads ordinary
    /// pages only from then on, so a history too long for one response never loops on it.
    public private(set) var catchUpFailed = false

    private let key: String
    private let cache: ConversationCache<Event>?

    public init(key: String, cache: ConversationCache<Event>?) {
        self.key = key
        self.cache = cache
        snapshot = cache?.snapshot(for: key) ?? ConversationSnapshot()
    }

    /// Shows a snapshot kept from an earlier visit, without any request. Returns whether one was.
    @discardableResult
    public func showCached(_ show: Show) async -> Bool {
        guard !hasShown, !snapshot.events.isEmpty || snapshot.cursor != nil else { return false }
        hasShown = true
        await show(snapshot.events)
        return true
    }

    /// Reads from the cursor until the server's end: one ordinary page, then catch-up reads while
    /// it reports more. `show` follows every read that changed something (and the first read).
    public func catchUp<Failure: Error>(
        _ fetch: (_ cursor: String?, _ read: ConversationRead) async throws(Failure) -> ConversationPage<Event>,
        show: Show
    ) async throws(Failure) {
        var read = ConversationRead.page
        while !Task.isCancelled {
            let page: ConversationPage<Event>
            do throws(Failure) {
                page = try await fetch(snapshot.cursor, read)
            } catch {
                if read == .catchUp { catchUpFailed = true }
                throw error
            }
            let advanced = await apply(page, show: show)
            guard !isCaughtUp, advanced else { return }
            read = nextRead
        }
    }

    /// Shows the cached snapshot, catches up, then polls until the calling task is cancelled or
    /// `onFailure` stops it. `pollDelay` is read after every read that reached the end; after a
    /// failure `onFailure` returns the backoff, or nil to stop. After a failed catch-up read, every
    /// later read of this loader is an ordinary page (`catchUpFailed`).
    public func run<C: Clock, Failure: Error>(
        clock: C,
        fetch: (_ cursor: String?, _ read: ConversationRead) async throws(Failure) -> ConversationPage<Event>,
        show: Show,
        pollDelay: @MainActor () -> C.Duration,
        onRead: @MainActor () -> Void = {},
        onFailure: @MainActor (_ failure: Failure, _ consecutive: Int) -> C.Duration?
    ) async {
        await showCached(show)
        var read = ConversationRead.page
        var failures = 0
        while !Task.isCancelled {
            do throws(Failure) {
                let page = try await fetch(snapshot.cursor, read)
                guard !Task.isCancelled else { return }
                let advanced = await apply(page, show: show)
                failures = 0
                onRead()
                if !isCaughtUp, advanced {
                    read = nextRead
                    continue
                }
                read = .page
                try? await clock.sleep(for: pollDelay())
            } catch {
                guard !Task.isCancelled else { return }
                if read == .catchUp { catchUpFailed = true }
                failures += 1
                read = .page
                guard let backoff = onFailure(error, failures) else { return }
                try? await clock.sleep(for: backoff)
            }
        }
    }

    /// The read after one that reported more: a catch-up, unless one already failed.
    private var nextRead: ConversationRead { catchUpFailed ? .page : .catchUp }

    /// Forgets this conversation in memory (for example after a refused read).
    public func forget() {
        cache?.remove(key)
    }

    /// Applies one read. Returns whether the cursor advanced.
    private func apply(_ page: ConversationPage<Event>, show: Show) async -> Bool {
        let previous = snapshot.cursor
        if let next = page.cursor { snapshot.cursor = next }
        let changed = EventStream.merge(page.events, into: &snapshot.events)
        isCaughtUp = !page.hasMore
        if changed || !hasShown {
            hasShown = true
            cache?.store(snapshot, for: key)
            await show(snapshot.events)
        } else if snapshot.cursor != previous {
            cache?.store(snapshot, for: key)
        }
        return snapshot.cursor != previous
    }
}
