import ArmadaKit
import Foundation
import Observation

/// The owner's orchestrators in the selected organization, in the order the server pages them
/// (the view groups them by status, newest first, with `ListOrdering`), plus a create command whose outcome is not known yet. That command lives in
/// ArmadaKit's durable store, so it survives dismissing the sheet and relaunching the app.
@MainActor
@Observable
final class OrchestratorListModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case unavailable(String)
        case failed(String)
    }

    enum CreateStatus: Equatable {
        case sending
        /// Accepted by the server and still being created; another create waits for it.
        case inProgress
        /// Sent, outcome unknown. Retry the same command or explicitly forget local tracking.
        case unconfirmed
        /// Saved but not sent, because the capability is off. Retrying sends the same command.
        case notSent(String)
        case refused(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var items: [OrchestratorSummary] = []
    private(set) var loadingMore = false
    private(set) var refreshError: String?
    private(set) var createStatus: CreateStatus?
    private(set) var isDiscardingCreate = false
    private(set) var createRecoveryError: String?
    /// The name of the pending create when this launch made it; nil when recovered from an earlier one.
    private(set) var pendingCreateName: String?

    @ObservationIgnored private var pendingCreateHandle: String?
    /// Creates the server refused in this launch; never offered again as a retry.
    @ObservationIgnored private var refusedHandles = Set<String>()
    @ObservationIgnored private var followTask: Task<Void, Never>?
    @ObservationIgnored private var cursor: String?
    @ObservationIgnored private var consecutiveReadFailures = 0
    @ObservationIgnored let service: any OrchestratorService
    @ObservationIgnored let orgID: String
    @ObservationIgnored private let onSignedOut: @MainActor () -> Void

    init(service: any OrchestratorService, orgID: String, onSignedOut: @escaping @MainActor () -> Void) {
        self.service = service
        self.orgID = orgID
        self.onSignedOut = onSignedOut
    }

    var hasMore: Bool { cursor != nil }

    /// A create command is open: the form stays locked until it resolves.
    var hasOpenCreate: Bool { pendingCreateHandle != nil && createStatus != nil }

    func load() async {
        if items.isEmpty { phase = .loading }
        do throws(ServiceFailure) {
            let page = try await service.list(orgID: orgID, cursor: nil)
            items = page.items
            cursor = page.cursor
            refreshError = nil
            phase = .loaded
            consecutiveReadFailures = 0
        } catch {
            consecutiveReadFailures += 1
            handleReadFailure(error)
        }
        await recoverOpenCreate()
    }

    /// Changes whenever the list polling policy could choose another delay.
    var pollKey: String {
        items.map { "\($0.id):\($0.state.rawValue)" }.joined(separator: ",") + "|\(String(describing: createStatus))"
    }

    /// Refreshes the first page while an orchestrator is creating, stopping or resuming, or a create
    /// is in progress, so its state appears without pulling. ArmadaKit's `OrchestratorPolling`
    /// decides the delay; failed reads back off. Ends when nothing is changing.
    func pollWhileChanging() async {
        while !Task.isCancelled {
            var states = items.map(\.state.rawValue)
            if createStatus == .inProgress { states.append("creating") }
            guard phase == .loaded, let delay = ArmadaKit.OrchestratorPolling.listDelay(
                states: states, consecutiveFailures: consecutiveReadFailures
            ) else { return }
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await refreshFirstPage()
        }
    }

    /// Re-reads the first page and updates those rows in place, keeping pages already loaded
    /// with "load more" (and their cursor) instead of collapsing the list to one page.
    private func refreshFirstPage() async {
        do throws(ServiceFailure) {
            let page = try await service.list(orgID: orgID, cursor: nil)
            let fresh = Dictionary(page.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            let known = Set(items.map(\.id))
            let onlyFirstPageLoaded = items.count <= page.items.count
            items = page.items.filter { !known.contains($0.id) } + items.map { fresh[$0.id] ?? $0 }
            if onlyFirstPageLoaded { cursor = page.cursor }
            refreshError = nil
            consecutiveReadFailures = 0
        } catch {
            consecutiveReadFailures += 1
            handleReadFailure(error)
        }
        await recoverOpenCreate()
    }

    func loadMore() async {
        guard let cursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do throws(ServiceFailure) {
            let page = try await service.list(orgID: orgID, cursor: cursor)
            let known = Set(items.map(\.id))
            items.append(contentsOf: page.items.filter { !known.contains($0.id) })
            self.cursor = page.cursor
        } catch {
            handleReadFailure(error)
        }
    }

    /// Saves a new create command and sends it. Nothing new is saved while one is open.
    /// Returns the new orchestrator's id when the server accepted it.
    func create(_ request: OrchestratorCreateRequest) async -> String? {
        guard !isDiscardingCreate, pendingCreateHandle == nil else { return nil }
        createStatus = .sending
        pendingCreateName = request.name
        do throws(ServiceFailure) {
            pendingCreateHandle = try await service.prepareCreate(request)
        } catch {
            if error == .signedOut {
                onSignedOut()
            } else {
                createStatus = .refused(error.message)
            }
            return nil
        }
        return await submit()
    }

    /// Resends exactly the saved command.
    func retryCreate() async -> String? {
        guard !isDiscardingCreate, pendingCreateHandle != nil, createStatus != .sending else { return nil }
        return await submit()
    }

    /// Called only after the person confirms that forgetting tracking can lead to duplicate effects.
    func discardUnconfirmedCreate() async {
        guard !isDiscardingCreate, createStatus == .unconfirmed, let handle = pendingCreateHandle else { return }
        isDiscardingCreate = true
        createRecoveryError = nil
        defer { isDiscardingCreate = false }
        do throws(ServiceFailure) {
            try await service.discardUncertain(handle: handle)
            pendingCreateHandle = nil
            pendingCreateName = nil
            createStatus = nil
            await load()
        } catch {
            if error == .signedOut { onSignedOut() }
            createRecoveryError = error.message
        }
    }

    /// Clears a refused create. Unknown outcomes require the separate, explicitly confirmed path.
    func clearRefusedCreate() {
        guard case .refused = createStatus else { return }
        createStatus = nil
        pendingCreateName = nil
        if let handle = pendingCreateHandle {
            pendingCreateHandle = nil
            Task { await service.discard(handle: handle) }
        }
    }

    private func submit() async -> String? {
        guard let handle = pendingCreateHandle else { return nil }
        createStatus = .sending
        createRecoveryError = nil
        do throws(ServiceFailure) {
            let operation = try await service.submit(handle: handle)
            if operation.state == .failed {
                refusedHandles.insert(handle)
                pendingCreateHandle = nil
                createStatus = .refused(ArmadaKit.OrchestratorExplanation.text(for: operation.errorCode ?? "create_failed"))
                return nil
            }
            if operation.state != .succeeded { follow(handle) }
            pendingCreateHandle = nil
            createStatus = nil
            pendingCreateName = nil
            await load()
            return operation.orchestratorID
        } catch {
            switch error {
            case .signedOut:
                onSignedOut()
            case .uncertain, .offline:
                createStatus = .unconfirmed
            case .unavailable(let reason):
                createStatus = .notSent(reason)
            case .rejected, .noAccess, .staleRevision:
                // The service asks ArmadaKit to forget a definitively refused command.
                refusedHandles.insert(handle)
                pendingCreateHandle = nil
                createStatus = .refused(error.message)
            }
            return nil
        }
    }

    /// Follows an accepted create until it settles (ArmadaKit's create → poll flow), then reloads
    /// so its row and the saved command reflect the outcome even when nothing else polls.
    private func follow(_ handle: String) {
        followTask?.cancel()
        followTask = Task { [weak self, service] in
            let settlement = try? await service.followCreate(handle: handle)
            guard !Task.isCancelled, settlement != nil, let self else { return }
            await self.load()
        }
    }

    private func recoverOpenCreate() async {
        guard createStatus != .sending, !isDiscardingCreate else { return }
        let trackedHandle = pendingCreateHandle
        guard let open = await service.unresolved(orgID: orgID, orchestratorID: nil) else {
            if let trackedHandle, pendingCreateHandle == trackedHandle {
                pendingCreateHandle = nil
                pendingCreateName = nil
                createStatus = nil
            }
            return
        }
        if refusedHandles.contains(open.handle) {
            pendingCreateHandle = open.handle
            createStatus = .refused(
                "Armada refused this create, and it is still saved on this device, so another can't start yet. Refresh and try dismissing it again."
            )
            return
        }
        if let receipt = open.receipt, receipt.state != .uncertain {
            // Accepted: once the orchestrator is listed past creating, read its final receipt so
            // the saved command is forgotten; until then it is in progress, not unknown.
            if items.contains(where: { $0.id == receipt.orchestratorID && $0.state != .creating }) {
                await service.settle(handle: open.handle)
                if await service.unresolved(orgID: orgID, orchestratorID: nil)?.handle != open.handle {
                    if pendingCreateHandle == open.handle {
                        pendingCreateHandle = nil
                        pendingCreateName = nil
                        createStatus = nil
                    }
                    return
                }
            }
            pendingCreateHandle = open.handle
            pendingCreateName = items.first { $0.id == receipt.orchestratorID }?.name
            createStatus = .inProgress
            return
        }
        pendingCreateHandle = open.handle
        if trackedHandle != open.handle { pendingCreateName = nil }
        createStatus = .unconfirmed
    }

    private func handleReadFailure(_ error: ServiceFailure) {
        if Task.isCancelled { return }
        switch error {
        case .signedOut:
            onSignedOut()
        case .unavailable(let reason):
            phase = .unavailable(reason)
        default:
            if items.isEmpty {
                phase = .failed(error.message)
            } else {
                refreshError = error.message
            }
        }
    }
}
