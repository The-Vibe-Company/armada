import Foundation
import Testing
@testable import ArmadaKit

struct OrderingRow: Sendable, Equatable {
    let id: String
    let state: String
    let created: Int
}

private func orchestrators(_ rows: [OrderingRow]) -> [String] {
    ListOrdering.sorted(rows, group: { .orchestrator($0.state) }, createdAt: { Date(timeIntervalSince1970: TimeInterval($0.created)) }, id: \.id).map(\.id)
}

@Test(arguments: [
    ("blocked", ListStatusGroup.attention), ("ready", .active), ("working", .active),
    ("creating", .transition), ("resuming", .transition), ("stopping", .transition),
    ("stopped", .stopped), ("failed", .other), ("deleted", .other), ("brand_new", .other),
])
func orchestratorStatesMapToGroups(state: String, group: ListStatusGroup) {
    #expect(ListStatusGroup.orchestrator(state) == group)
}

@Test(arguments: [
    ("ready", ListStatusGroup.active), ("running", .active), ("starting", .transition), ("stopping", .transition),
    ("stopped", .stopped), ("failed", .other), ("deleted", .other), ("brand_new", .other),
])
func sandboxStatusesMapToGroups(status: String, group: ListStatusGroup) {
    #expect(ListStatusGroup.sandbox(status) == group)
}

let orderingCases: [([OrderingRow], [String])] = [
    // Group first, whatever the creation date.
    ([OrderingRow(id: "s", state: "stopped", created: 9), OrderingRow(id: "r", state: "ready", created: 1), OrderingRow(id: "b", state: "blocked", created: 0)], ["b", "r", "s"]),
    // Transition sits between active and stopped; unknown and failed come last.
    ([OrderingRow(id: "x", state: "failed", created: 9), OrderingRow(id: "c", state: "creating", created: 1), OrderingRow(id: "t", state: "stopped", created: 5), OrderingRow(id: "a", state: "ready", created: 0)], ["a", "c", "t", "x"]),
    // Newest first inside a group.
    ([OrderingRow(id: "old", state: "ready", created: 1), OrderingRow(id: "new", state: "ready", created: 3), OrderingRow(id: "mid", state: "ready", created: 2)], ["new", "mid", "old"]),
    // Same group and date: by id, so the server's order never matters.
    ([OrderingRow(id: "b", state: "stopped", created: 1), OrderingRow(id: "a", state: "stopped", created: 1)], ["a", "b"]),
    ([], []),
]

@Test(arguments: orderingCases)
func ordersByGroupThenNewest(rows: [OrderingRow], expected: [String]) {
    #expect(orchestrators(rows) == expected)
}

@Test func refreshInAnotherOrderKeepsRowsStillUnlessAStatusChanges() {
    let rows = [OrderingRow(id: "a", state: "ready", created: 1), OrderingRow(id: "b", state: "ready", created: 2), OrderingRow(id: "c", state: "stopped", created: 3)]
    #expect(orchestrators(rows) == orchestrators(rows.reversed()))
    let changed = [OrderingRow(id: "a", state: "blocked", created: 1), OrderingRow(id: "b", state: "ready", created: 2), OrderingRow(id: "c", state: "stopped", created: 3)]
    #expect(orchestrators(changed) == ["a", "b", "c"])
}

@Test func sectionsCountTheirRowsAndCollapseStoppedOnlyBesideLiveOnes() {
    let rows = [OrderingRow(id: "s1", state: "stopped", created: 1), OrderingRow(id: "r", state: "ready", created: 2), OrderingRow(id: "s2", state: "stopped", created: 3)]
    let sections = ListOrdering.sections(rows, group: { .orchestrator($0.state) }, createdAt: { Date(timeIntervalSince1970: TimeInterval($0.created)) }, id: \.id)
    #expect(sections.map(\.group) == [.active, .stopped])
    #expect(sections.map { $0.items.map(\.id) } == [["r"], ["s2", "s1"]])
    #expect(ListOrdering.collapsedByDefault(.stopped, groups: [.active, .stopped]))
    #expect(!ListOrdering.collapsedByDefault(.stopped, groups: [.stopped]))
    #expect(!ListOrdering.collapsedByDefault(.active, groups: [.active, .stopped]))
}
