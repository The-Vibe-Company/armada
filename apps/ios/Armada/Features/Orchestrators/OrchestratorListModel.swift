import Foundation
import Observation

/// The owner's orchestrators in the selected organization, newest page first as the server
/// returns them, plus the create request whose outcome is not known yet.
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
        /// Sent, outcome unknown. Only a retry with the same key is offered.
        case unconfirmed
        case refused(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var items: [OrchestratorSummary] = []
    private(set) var loadingMore = false
    private(set) var refreshError: String?
    private(set) var pendingCreate: PendingMutation<OrchestratorCreateRequest>?
    private(set) var createStatus: CreateStatus?

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

    /// Starts a create with a fresh key, unless one is already pending: then nothing new is sent.
    /// Returns the new orchestrator's id when the server accepted the request.
    func create(_ request: OrchestratorCreateRequest) async -> String? {
        guard pendingCreate == nil else { return nil }
        let mutation = PendingMutation(request: request)
        pendingCreate = mutation
        return await send(mutation)
    }

    /// Resends the exact pending request with its original key.
    func retryCreate() async -> String? {
        guard let pendingCreate, createStatus != .sending else { return nil }
        return await send(pendingCreate)
    }

    /// Forgets a create the server refused. An unconfirmed create cannot be discarded here: it
    /// may still be allocating, and only its own key can reconcile it.
    func clearRefusedCreate() {
        guard case .refused = createStatus else { return }
        pendingCreate = nil
        createStatus = nil
    }

    private func send(_ mutation: PendingMutation<OrchestratorCreateRequest>) async -> String? {
        createStatus = .sending
        do throws(ServiceFailure) {
            let operation = try await service.create(mutation.request, idempotencyKey: mutation.idempotencyKey)
            pendingCreate = nil
            createStatus = nil
            await load()
            return operation.orchestratorID
        } catch {
            switch error {
            case .signedOut:
                onSignedOut()
            case .uncertain, .offline:
                createStatus = .unconfirmed
            case .unavailable(let reason):
                pendingCreate = nil
                createStatus = nil
                phase = .unavailable(reason)
            case .noAccess, .staleRevision, .rejected:
                createStatus = .refused(error.message)
            }
            return nil
        }
    }

    private func handleReadFailure(_ error: ServiceFailure) {
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
