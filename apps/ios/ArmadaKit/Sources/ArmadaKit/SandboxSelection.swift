import Foundation

/// The detail surface shown beside (or pushed from) the sandbox list.
public enum SandboxDetailDestination<Item> {
    case empty
    case conversation(Item)
    case metadataOnly(Item)
}

extension SandboxDetailDestination: Equatable where Item: Equatable {}
extension SandboxDetailDestination: Sendable where Item: Sendable {}

/// Pure selection and detail-routing state for the adaptive `NavigationSplitView` workspace.
///
/// Resolves `selectedID` against the freshest loaded `items`, falling back to the cached `snapshot`
/// (e.g. a newly launched sandbox before page 1 reloads, or a page-2 item after a page-1 refresh),
/// and clears selection and snapshot whenever the active organization changes.
public struct SandboxSelection<Item> {
    public var selectedID: String?
    public private(set) var snapshot: Item?
    public private(set) var orgID: String?

    public init(selectedID: String? = nil, snapshot: Item? = nil, orgID: String? = nil) {
        self.selectedID = selectedID
        self.snapshot = snapshot
        self.orgID = orgID
    }

    /// Selects a sandbox immediately (for example, on launch before the list reloads).
    /// Ignores items belonging to a different organization than the active one.
    public mutating func select(
        _ item: Item,
        id: (Item) -> String,
        orgID itemOrgID: (Item) -> String
    ) {
        let itemOrg = itemOrgID(item)
        if let activeOrg = self.orgID, activeOrg != itemOrg { return }
        self.orgID = itemOrg
        selectedID = id(item)
        snapshot = item
    }

    /// Refreshes the cached snapshot from `items` for the current `selectedID`.
    /// Clears `snapshot` when `selectedID` is nil or belongs to another item or organization.
    public mutating func sync(
        items: [Item],
        id: (Item) -> String,
        orgID itemOrgID: (Item) -> String
    ) {
        guard let selectedID else {
            snapshot = nil
            return
        }
        if let fresh = items.first(where: { id($0) == selectedID }) {
            if let activeOrg = self.orgID, itemOrgID(fresh) != activeOrg {
                self.selectedID = nil
                snapshot = nil
            } else {
                if self.orgID == nil { self.orgID = itemOrgID(fresh) }
                snapshot = fresh
            }
        } else if let existing = snapshot,
                  id(existing) != selectedID || (self.orgID != nil && itemOrgID(existing) != self.orgID) {
            snapshot = nil
        }
    }

    /// Clears selection and snapshot when switching organizations, while preserving them
    /// when the same organization remains active (such as across fold/unfold/rotation).
    public mutating func updateOrganization(_ newOrgID: String?) {
        guard orgID != newOrgID else { return }
        orgID = newOrgID
        selectedID = nil
        snapshot = nil
    }

    /// Resolves the selected item, preferring the freshest row in `items` and falling back
    /// to the cached `snapshot` when it matches `selectedID` and the active organization.
    public func resolved(
        from items: [Item],
        id: (Item) -> String,
        orgID itemOrgID: (Item) -> String
    ) -> Item? {
        guard let selectedID else { return nil }
        if let fresh = items.first(where: { id($0) == selectedID }) {
            if let activeOrg = self.orgID, itemOrgID(fresh) != activeOrg { return nil }
            return fresh
        }
        if let snapshot, id(snapshot) == selectedID {
            if let activeOrg = self.orgID, itemOrgID(snapshot) != activeOrg { return nil }
            return snapshot
        }
        return nil
    }

    /// Routes the resolved selection to conversation (`canOpen == true`), metadata-only detail
    /// (`canOpen == false`), or the empty detail state.
    public func destination(
        from items: [Item],
        id: (Item) -> String,
        orgID itemOrgID: (Item) -> String,
        canOpen: (Item) -> Bool
    ) -> SandboxDetailDestination<Item> {
        guard let item = resolved(from: items, id: id, orgID: itemOrgID) else {
            return .empty
        }
        return canOpen(item) ? .conversation(item) : .metadataOnly(item)
    }
}

extension SandboxSelection: Equatable where Item: Equatable {}
extension SandboxSelection: Sendable where Item: Sendable {}
