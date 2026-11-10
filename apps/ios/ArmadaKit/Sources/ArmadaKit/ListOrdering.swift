import Foundation

/// The status group a listed orchestrator or sandbox belongs to, in display order.
public enum ListStatusGroup: Int, CaseIterable, Comparable, Sendable {
    /// Blocked: someone has to act.
    case attention
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
        case .active: "Active"
        case .transition: "In Transition"
        case .stopped: "Stopped"
        case .other: "Other"
        }
    }

    /// Group of an orchestrator wire state (`packages/core/src/orchestrator.ts`).
    public static func orchestrator(_ state: String) -> Self {
        switch state {
        case "blocked": .attention
        case "ready", "working": .active
        case "creating", "resuming", "stopping": .transition
        case "stopped": .stopped
        default: .other
        }
    }

    /// Group of a sandbox wire status. A sandbox has no blocked state; failed sorts with the rest.
    public static func sandbox(_ status: String) -> Self {
        switch status {
        case "ready", "running": .active
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
