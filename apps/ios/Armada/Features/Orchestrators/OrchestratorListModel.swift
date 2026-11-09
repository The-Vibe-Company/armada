import Foundation
import Observation

/// The owner's orchestrators in the selected organization, newest page first as the server
/// returns them, plus a create command whose outcome is not known yet. That command lives in
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
        /// Sent, outcome unknown. Only a retry of the same saved command is offered.
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
    /// The name of the pending create when this launch made it; nil when recovered from an earlier one.
    private(set) var pendingCreateName: String?

    @ObservationIgnored private var pendingCreateHandle: String?
    /// Creates the server refused in this launch; never offered again as a retry.
    @ObservationIgnored private var refusedHandles = Set<String>()
    @ObservationIgnored private var cursor: String?
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
        } catch {
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
        guard pendingCreateHandle == nil else { return nil }
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
        guard pendingCreateHandle != nil, createStatus != .sending else { return nil }
        return await submit()
    }

    /// Clears a refused create. An unconfirmed or unsent command stays saved: only its own key
    /// can reconcile it.
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
        do throws(ServiceFailure) {
            let operation = try await service.submit(handle: handle)
            if operation.state == .failed {
                refusedHandles.insert(handle)
                pendingCreateHandle = nil
                createStatus = .refused(operation.errorCode.map { "Armada could not create it (\($0))." } ?? "Armada could not create it.")
                return nil
            }
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

    private func recoverOpenCreate() async {
        guard pendingCreateHandle == nil, createStatus != .sending,
              let open = await service.unresolved(orgID: orgID, orchestratorID: nil) else { return }
        if refusedHandles.contains(open.handle) {
            pendingCreateHandle = open.handle
            createStatus = .refused(
                "Armada refused this create, and it is still saved on this device, so another can't start yet. Signing out clears it."
            )
            return
        }
        if let receipt = open.receipt {
            // Accepted: once the orchestrator is listed past creating, read its final receipt so
            // the saved command is forgotten; until then it is in progress, not unknown.
            if items.contains(where: { $0.id == receipt.orchestratorID && $0.state != .creating }) {
                await service.settle(handle: open.handle)
                if await service.unresolved(orgID: orgID, orchestratorID: nil)?.handle != open.handle { return }
            }
            pendingCreateHandle = open.handle
            pendingCreateName = items.first { $0.id == receipt.orchestratorID }?.name
            createStatus = .inProgress
            return
        }
        pendingCreateHandle = open.handle
        pendingCreateName = nil
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
