import Foundation
import Testing
@testable import ArmadaKit

struct OrderingRow: Sendable, Equatable {
    let id: String
    let state: String
    let created: Int
}

private func sandboxes(_ rows: [OrderingRow]) -> [String] {
    ListOrdering.sorted(rows, group: { .sandbox($0.state) }, createdAt: { Date(timeIntervalSince1970: TimeInterval($0.created)) }, id: \.id).map(\.id)
}

@Test(arguments: [
    ("ready", ListStatusGroup.active), ("running", .working), ("starting", .transition), ("stopping", .transition),
    ("stopped", .stopped), ("failed", .other), ("deleted", .other), ("brand_new", .other),
])
func sandboxStatusesMapToGroups(status: String, group: ListStatusGroup) {
    #expect(ListStatusGroup.sandbox(status) == group)
}

let orderingCases: [([OrderingRow], [String])] = [
    // Group first, whatever the creation date: working before active before stopped.
    ([OrderingRow(id: "s", state: "stopped", created: 9), OrderingRow(id: "r", state: "ready", created: 1), OrderingRow(id: "b", state: "running", created: 0)], ["b", "r", "s"]),
    // Transition sits between active and stopped; unknown and failed come last.
    ([OrderingRow(id: "x", state: "failed", created: 9), OrderingRow(id: "c", state: "starting", created: 1), OrderingRow(id: "t", state: "stopped", created: 5), OrderingRow(id: "a", state: "ready", created: 0)], ["a", "c", "t", "x"]),
    // Newest first inside a group.
    ([OrderingRow(id: "old", state: "ready", created: 1), OrderingRow(id: "new", state: "ready", created: 3), OrderingRow(id: "mid", state: "ready", created: 2)], ["new", "mid", "old"]),
    // Same group and date: by id, so the server's order never matters.
    ([OrderingRow(id: "b", state: "stopped", created: 1), OrderingRow(id: "a", state: "stopped", created: 1)], ["a", "b"]),
    ([], []),
]

@Test(arguments: orderingCases)
func ordersByGroupThenNewest(rows: [OrderingRow], expected: [String]) {
    #expect(sandboxes(rows) == expected)
}

@Test func refreshInAnotherOrderKeepsRowsStillUnlessAStatusChanges() {
    let rows = [OrderingRow(id: "a", state: "ready", created: 1), OrderingRow(id: "b", state: "ready", created: 2), OrderingRow(id: "c", state: "stopped", created: 3)]
    #expect(sandboxes(rows) == sandboxes(rows.reversed()))
    let changed = [OrderingRow(id: "a", state: "stopped", created: 1), OrderingRow(id: "b", state: "ready", created: 2), OrderingRow(id: "c", state: "stopped", created: 3)]
    #expect(sandboxes(changed) == ["b", "c", "a"])
}

@Test func sectionsCountTheirRowsAndCollapseStoppedOnlyBesideLiveOnes() {
    let rows = [OrderingRow(id: "s1", state: "stopped", created: 1), OrderingRow(id: "r", state: "ready", created: 2), OrderingRow(id: "s2", state: "stopped", created: 3)]
    let sections = ListOrdering.sections(rows, group: { .sandbox($0.state) }, createdAt: { Date(timeIntervalSince1970: TimeInterval($0.created)) }, id: \.id)
    #expect(sections.map(\.group) == [.active, .stopped])
    #expect(sections.map { $0.items.map(\.id) } == [["r"], ["s2", "s1"]])
    #expect(ListOrdering.collapsedByDefault(.stopped, groups: [.active, .stopped]))
    #expect(!ListOrdering.collapsedByDefault(.stopped, groups: [.stopped]))
    #expect(!ListOrdering.collapsedByDefault(.active, groups: [.active, .stopped]))
    #expect(ListOrdering.collapsedByDefault(.stopped, groups: [.working, .stopped]))
    #expect(!ListOrdering.collapsedByDefault(.working, groups: [.working, .stopped]))
}

@Test func recordedTurnsPromoteActiveRuntimeSandboxesToWorkingGroup() {
    let now = Date(timeIntervalSince1970: 1_762_646_400), future = now.addingTimeInterval(600), past = now.addingTimeInterval(-60)
    #expect(ListStatusGroup.working.title == "Working")
    let cases: [(String, RecordedTurnState?, Date?, ListStatusGroup)] = [
        ("ready", .running, nil, .working), ("ready", .queued, nil, .working),
        ("ready", .finished, nil, .active), ("ready", .other("paused"), nil, .active),
        ("running", .finished, nil, .active), ("starting", .queued, nil, .working),
        ("stopped", .queued, future, .working), ("stopped", .queued, past, .stopped),
        ("stopped", .running, future, .stopped), ("failed", .running, nil, .other), ("deleted", .queued, nil, .other),
    ]
    for (status, turn, expiry, expected) in cases {
        #expect(ListStatusGroup.sandbox(status, turn: turn, expiresAt: expiry, now: now) == expected)
    }
    let turns: [String: RecordedTurnState] = ["ready-working": .running, "ready-idle": .finished]
    let rows = [OrderingRow(id: "ready-idle", state: "ready", created: 10), OrderingRow(id: "ready-working", state: "ready", created: 1), OrderingRow(id: "stopped-row", state: "stopped", created: 20)]
    let sections = ListOrdering.sections(rows, group: { .sandbox($0.state, turn: turns[$0.id], now: now) }, createdAt: { Date(timeIntervalSince1970: TimeInterval($0.created)) }, id: \.id)
    #expect(sections.map(\.group) == [.working, .active, .stopped])
    #expect(sections.map { $0.items.map(\.id) } == [["ready-working"], ["ready-idle"], ["stopped-row"]])
}
