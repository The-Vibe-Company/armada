import Foundation

/// Per-screen detail-read cadence. Healthy reads keep the existing working/idle intervals;
/// network failures must back off without delaying an explicit refresh.
public struct ConversationDetailPolling: Sendable {
    private var failures = 0

    public init() {}

    public mutating func succeeded() { failures = 0 }
    public mutating func failed() { failures = min(4, failures + 1) }

    public func delay(busy: Bool) -> Duration {
        .seconds(busy ? 3 : 15)
    }
}
