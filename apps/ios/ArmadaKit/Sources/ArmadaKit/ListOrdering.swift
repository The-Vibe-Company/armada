import Foundation

/// The status group a listed sandbox belongs to, in display order.
public enum ListStatusGroup: Int, CaseIterable, Comparable, Sendable {
    /// Blocked: someone has to act.
    case attention
    /// Actively running a turn or has a queued/running turn.
    case working
    /// Has compute and can take work now.
    case active
    /// Starting, resuming or stopping on its own.
    case transition
    case stopped
    /// Failed, deleted or a state this build does not know.
    case other

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }

    public var title: String {
        switch self {
        case .attention: "Needs Attention"
        case .working: "Working"
        case .active: "Active"
        case .transition: "In Transition"
        case .stopped: "Stopped"
        case .other: "Other"
        }
    }

    /// Group of a sandbox wire status and optional recorded turn activity (`sandbox/list-turns`).
    public static func sandbox(
        _ status: String,
        turn: RecordedTurnState? = nil,
        expiresAt: Date? = nil,
        now: Date = .now
    ) -> Self {
        if RecordedTurnState.isWorking(status: status, turn: turn, expiresAt: expiresAt, now: now) {
            return .working
        }
        return switch status {
        case "ready": .active
        case "starting", "stopping": .transition
        case "stopped": .stopped
        default: .other
        }
    }
}

/// The phone's list order: status group first, then newest created first, then id. The order
/// depends only on each row's own values, so a refresh moves a row only when its status changes.
/// It orders what is loaded; pages the server has not sent yet join their group when they arrive.
public enum ListOrdering {
    public struct Section<Item> {
        public let group: ListStatusGroup
        public let items: [Item]
    }

    public static func sorted<Item>(
        _ items: [Item],
        group: (Item) -> ListStatusGroup,
        createdAt: (Item) -> Date,
        id: (Item) -> String
    ) -> [Item] {
        items
            .map { (item: $0, group: group($0), created: createdAt($0), id: id($0)) }
            .sorted {
                if $0.group != $1.group { return $0.group < $1.group }
                if $0.created != $1.created { return $0.created > $1.created }
                return $0.id < $1.id
            }
            .map { $0.item }
    }

    /// Non-empty groups in display order, each sorted newest first.
    public static func sections<Item>(
        _ items: [Item],
        group: (Item) -> ListStatusGroup,
        createdAt: (Item) -> Date,
        id: (Item) -> String
    ) -> [Section<Item>] {
        let ordered = sorted(items, group: group, createdAt: createdAt, id: id)
        let grouped = Dictionary(grouping: ordered, by: group)
        return ListStatusGroup.allCases.compactMap { key in
            grouped[key].map { Section(group: key, items: $0) }
        }
    }

    /// Stopped starts collapsed when anything else is listed, so the live rows come first.
    public static func collapsedByDefault(_ group: ListStatusGroup, groups: [ListStatusGroup]) -> Bool {
        group == .stopped && groups.contains { $0 != .stopped }
    }
}

extension ListOrdering.Section: Sendable where Item: Sendable {}
