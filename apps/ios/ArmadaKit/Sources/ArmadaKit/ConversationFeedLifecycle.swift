import Foundation

/// The presentation lifecycle of one conversation. Revocation is terminal: a new authorized
/// screen creates a new lifecycle. Keep connection feedback separate from whether retries exist.
public struct ConversationFeedLifecycle<Failure: Error & Equatable & Sendable>: Sendable {
    public enum Connection: Equatable, Sendable {
        case connecting
        case live
        case reconnecting(String)
        case stopped(Failure)
    }

    public private(set) var connection: Connection = .connecting
    public private(set) var isRevoked = false

    public init() {}

    public func canKeepHistory(hasPublished: Bool, hasWindow: Bool) -> Bool {
        !isRevoked && (hasPublished || hasWindow)
    }

    @discardableResult
    public func publish<Value: Sendable>(_ value: Value, apply: (Value) -> Void) -> Bool {
        guard !isRevoked, !Task.isCancelled else { return false }
        apply(value)
        return true
    }

    public mutating func readSucceeded() {
        guard !isRevoked else { return }
        connection = .live
    }

    public mutating func readFailed(_ failure: Failure, retryable: Bool, message: String) {
        guard !isRevoked else { return }
        connection = retryable ? .reconnecting(message) : .stopped(failure)
    }

    public mutating func refreshFailed(_ failure: Failure, message: String) {
        guard !isRevoked else { return }
        if case .stopped = connection { connection = .stopped(failure) }
        else { connection = .reconnecting(message) }
    }

    /// True when a successful explicit refresh must wake a stopped/backing-off follower.
    public mutating func refreshSucceeded() -> Bool {
        guard !isRevoked else { return false }
        let restart: Bool
        switch connection {
        case .stopped, .reconnecting: restart = true
        case .connecting, .live: restart = false
        }
        connection = .live
        return restart
    }

    /// Erasure is synchronous with revocation. Late read/render completion cannot publish again.
    public mutating func revoke(_ failure: Failure, erase: () -> Void) {
        if !isRevoked { connection = .stopped(failure) }
        isRevoked = true
        erase()
    }
}
