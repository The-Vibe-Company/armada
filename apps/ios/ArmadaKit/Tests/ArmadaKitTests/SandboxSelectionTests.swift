import Testing
@testable import ArmadaKit

private struct SelectionRow: Equatable, Sendable {
    let id: String
    let orgID: String
    let status: String
    let canOpen: Bool
}

@Test func prefersFreshItemOverCachedSnapshotAndFallsBackWhenMissingFromPageOne() {
    var selection = SandboxSelection<SelectionRow>()
    selection.updateOrganization("org-a")

    let launched = SelectionRow(id: "sb-new", orgID: "org-a", status: "starting", canOpen: true)
    selection.select(launched, id: \.id, orgID: \.orgID)

    // Before page 1 includes the newly launched sandbox, the cached snapshot opens the conversation.
    let beforeReload = [SelectionRow(id: "sb-old", orgID: "org-a", status: "ready", canOpen: true)]
    #expect(selection.resolved(from: beforeReload, id: \.id, orgID: \.orgID) == launched)
    #expect(selection.destination(from: beforeReload, id: \.id, orgID: \.orgID, canOpen: \.canOpen) == .conversation(launched))

    // Once page 1 reloads with fresher status, resolved() prefers the live item and sync() refreshes the snapshot.
    let fresh = SelectionRow(id: "sb-new", orgID: "org-a", status: "ready", canOpen: true)
    let afterReload = [fresh, beforeReload[0]]
    #expect(selection.resolved(from: afterReload, id: \.id, orgID: \.orgID) == fresh)
    selection.sync(items: afterReload, id: \.id, orgID: \.orgID)
    #expect(selection.snapshot == fresh)

    // If a later refresh drops the item from page 1, the refreshed snapshot keeps the detail pane alive.
    #expect(selection.resolved(from: beforeReload, id: \.id, orgID: \.orgID) == fresh)
}

@Test func routesOpenableToConversationAndNonOpenableToMetadataOnly() {
    var selection = SandboxSelection<SelectionRow>()
    selection.updateOrganization("org-a")

    let openable = SelectionRow(id: "sb-open", orgID: "org-a", status: "ready", canOpen: true)
    let locked = SelectionRow(id: "sb-locked", orgID: "org-a", status: "ready", canOpen: false)
    let items = [openable, locked]

    #expect(selection.destination(from: items, id: \.id, orgID: \.orgID, canOpen: \.canOpen) == .empty)

    selection.selectedID = openable.id
    selection.sync(items: items, id: \.id, orgID: \.orgID)
    #expect(selection.destination(from: items, id: \.id, orgID: \.orgID, canOpen: \.canOpen) == .conversation(openable))

    selection.selectedID = locked.id
    selection.sync(items: items, id: \.id, orgID: \.orgID)
    #expect(selection.destination(from: items, id: \.id, orgID: \.orgID, canOpen: \.canOpen) == .metadataOnly(locked))

    selection.selectedID = nil
    selection.sync(items: items, id: \.id, orgID: \.orgID)
    #expect(selection.snapshot == nil)
    #expect(selection.destination(from: items, id: \.id, orgID: \.orgID, canOpen: \.canOpen) == .empty)
}

@Test func clearsSelectionOnOrganizationSwitchAndPreservesWithinSameOrganization() {
    var selection = SandboxSelection<SelectionRow>()
    selection.updateOrganization("org-a")

    let rowA = SelectionRow(id: "sb-a", orgID: "org-a", status: "ready", canOpen: true)
    selection.select(rowA, id: \.id, orgID: \.orgID)

    // Re-entering the same org (e.g. fold/unfold/rotation) keeps selection and snapshot intact.
    selection.updateOrganization("org-a")
    #expect(selection.selectedID == "sb-a")
    #expect(selection.snapshot == rowA)

    // Switching orgs clears both selection and snapshot so a previous org's sandbox never lingers.
    selection.updateOrganization("org-b")
    #expect(selection.selectedID == nil)
    #expect(selection.snapshot == nil)
    #expect(selection.destination(from: [rowA], id: \.id, orgID: \.orgID, canOpen: \.canOpen) == .empty)

    // Cross-org selection attempts are rejected while org-b is active.
    selection.select(rowA, id: \.id, orgID: \.orgID)
    #expect(selection.selectedID == nil)
    #expect(selection.snapshot == nil)

    // Signing out (nil org) also clears any selection.
    let rowB = SelectionRow(id: "sb-b", orgID: "org-b", status: "ready", canOpen: true)
    selection.select(rowB, id: \.id, orgID: \.orgID)
    selection.updateOrganization(nil)
    #expect(selection.selectedID == nil)
    #expect(selection.snapshot == nil)
}
