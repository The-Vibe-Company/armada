import Foundation

/// Durable command identity. Call prepare once, then submit/retry its ID. The
/// exact bytes/key/revision survive process death in the device-only Keychain.
/// No public initializer: callers cannot replace an uncertain request's payload.
public struct PendingOrchestratorOperation: Codable, Sendable, Identifiable {
    public let id: UUID
    public let orgId: String
    public let orchestratorId: String?
    public let action: OrchestratorAction
    public let state: OrchestratorOperationState
    public let receipt: OrchestratorOperation?
    let route: String
    let body: Data
    let key: String
    let attempts: Int?
    var dispatchCount: Int { attempts ?? (state == .pending && receipt == nil ? 0 : 1) }
    init(orgId: String, orchestratorId: String?, action: OrchestratorAction, route: String, body: Data) {
        self.id = UUID(); self.orgId = orgId; self.orchestratorId = orchestratorId
        self.action = action; self.route = route; self.body = body
        self.key = UUID().uuidString; self.state = .pending; self.receipt = nil; self.attempts = 0
    }
    private init(_ prior: Self, state: OrchestratorOperationState, receipt: OrchestratorOperation?, attempts: Int?) {
        id = prior.id; orgId = prior.orgId; orchestratorId = prior.orchestratorId
        action = prior.action; route = prior.route; body = prior.body; key = prior.key
        self.state = state; self.receipt = receipt; self.attempts = attempts ?? prior.attempts
    }
    func updating(state: OrchestratorOperationState, receipt: OrchestratorOperation? = nil, attempts: Int? = nil) -> Self {
        Self(self, state: state, receipt: receipt, attempts: attempts)
    }
}

extension ArmadaClient {
    /// Actual delivered handler reports enabled:false/native_conformance_required.
    /// Route absent/unsupported means unavailable; never allocate a legacy sandbox.
    public func orchestratorCapabilities() async throws -> OrchestratorCapabilities {
        let result: OrchestratorCapabilities = try await authenticatedRequest("orchestrators/capabilities", method: "GET")
        guard result.version == 1 else { throw ArmadaError.invalidResponse }
        return result
    }
    public func orchestrators(cursor: String? = nil, limit: Int = 25) async throws -> OrchestratorList {
        let org = try selectedOrganization()
        guard (1...100).contains(limit) else { throw ArmadaError.invalidResponse }
        let result: OrchestratorList = try await authenticatedRequest("orchestrators", method: "GET", query: pageQuery(org, cursor, limit))
        guard result.version == 1, result.items.allSatisfy({ $0.version == 1 }) else { throw ArmadaError.invalidResponse }
        return result
    }
    public func orchestratorDetail(id: String) async throws -> OrchestratorDetail {
        let result: OrchestratorDetail = try await authenticatedRequest("orchestrators/" + safeID(id), method: "GET",
            query: [URLQueryItem(name: "orgId", value: try selectedOrganization())])
        guard result.version == 1, result.orchestrator.version == 1 else { throw ArmadaError.invalidResponse }
        return result
    }
    public func orchestratorEvents(id: String, cursor: String? = nil, limit: Int = 100) async throws -> OrchestratorEventPage {
        guard (1...500).contains(limit) else { throw ArmadaError.invalidResponse }
        let result: OrchestratorEventPage = try await authenticatedRequest("orchestrators/" + safeID(id) + "/events",
            method: "GET", query: pageQuery(try selectedOrganization(), cursor, limit))
        guard result.version == 1 else { throw ArmadaError.invalidResponse }
        // Return producer order and opaque cursor exactly; never synthesize events.
        return result
    }
    public func prepareOrchestratorCreate(_ configuration: OrchestratorCreate) throws -> PendingOrchestratorOperation {
        guard configuration.orgId == (try selectedOrganization()) else { throw ArmadaError.forbidden }
        return try enqueue(PendingOrchestratorOperation(orgId: configuration.orgId, orchestratorId: nil,
            action: .create, route: "orchestrators", body: JSONEncoder().encode(configuration)))
    }
    public func prepareOrchestratorMutation(id: String, action: OrchestratorAction, expectedRevision: Int,
                                            text: String? = nil) throws -> PendingOrchestratorOperation {
        struct Mutation: Encodable { let orgId: String; let expectedRevision: Int; let text: String? }
        guard action != .create, expectedRevision >= 0, expectedRevision <= 9_007_199_254_740_991 else { throw ArmadaError.invalidResponse }
        if action == .message || action == .steer {
            guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ArmadaError.invalidResponse }
        } else if text != nil { throw ArmadaError.invalidResponse }
        let org = try selectedOrganization()
        return try enqueue(PendingOrchestratorOperation(orgId: org, orchestratorId: id, action: action,
            route: "orchestrators/" + safeID(id) + "/" + action.rawValue,
            body: JSONEncoder().encode(Mutation(orgId: org, expectedRevision: expectedRevision, text: text))))
    }
    /// No automatic retry. Lost response/cancellation/decoding failure stays uncertain.
    /// Retry ONLY this saved ID, preserving the exact Idempotency-Key and CAS revision.
    public func submitOrchestratorOperation(_ operationID: UUID) async throws -> OrchestratorOperation {
        guard let pending = pendingOperations.first(where: { $0.id == operationID }),
              pending.orgId == (try selectedOrganization()) else { throw ArmadaError.forbidden }
        if let receipt = pending.receipt, receipt.state == .succeeded || receipt.state == .failed { return receipt }
        guard pending.state != .failed else { throw ArmadaError.http(400) }
        let capabilities = try await orchestratorCapabilities()
        guard capabilities.enabled else { throw ArmadaError.unavailable }
        // Recheck after suspension: signout/account switching cannot submit old work.
        guard pendingOperations.contains(where: { $0.id == operationID }), selectedOrgID == pending.orgId else { throw CancellationError() }
        guard let current = pendingOperations.first(where: { $0.id == operationID }) else { throw CancellationError() }
        if let receipt = current.receipt, receipt.state == .succeeded || receipt.state == .failed { return receipt }
        guard current.state != .failed else { throw ArmadaError.http(400) }
        let attempt = current.dispatchCount + 1
        try update(current.updating(state: .uncertain, receipt: current.receipt, attempts: attempt)) // persist BEFORE external effects
        do {
            let receipt: OrchestratorOperation = try await authenticatedRequest(pending.route, method: "POST", body: pending.body, key: pending.key)
            guard receipt.version == 1, receipt.kind == pending.action,
                  current.receipt == nil || current.receipt?.id == receipt.id,
                  pending.orchestratorId == nil || receipt.orchestratorId == pending.orchestratorId else { throw ArmadaError.invalidResponse }
            try update(pending.updating(state: receipt.state, receipt: receipt))
            return pendingOperations.first(where: { $0.id == operationID })?.receipt ?? receipt
        } catch let error as ArmadaError where error == .http(400) {
            // The actual handler's invalid_request response is pre-effect rejection.
            // Preserve any concurrent terminal receipt; otherwise allow explicit discard.
            if attempt == 1, pendingOperations.first(where: { $0.id == operationID })?.dispatchCount == attempt {
                try update(pending.updating(state: .failed))
            }
            // A refused retry cannot establish the earlier unknown outcome.
            throw error
        } catch {
            // Previously persisted uncertain bytes remain even if the response was lost.
            throw error
        }
    }
    /// Only a known terminal receipt or actual pre-effect HTTP400 may be discarded.
    /// Unknown/pending/uncertain effects cannot be abandoned and reallocated here.
    public func discardOrchestratorOperation(_ operationID: UUID) throws {
        guard let operation = pendingOperations.first(where: { $0.id == operationID }),
              operation.state == .succeeded || operation.state == .failed else { throw ArmadaError.conflict }
        try saveOperations(pendingOperations.filter { $0.id != operationID })
    }
    private func enqueue(_ operation: PendingOrchestratorOperation) throws -> PendingOrchestratorOperation {
        guard !pendingOperations.contains(where: {
            $0.orgId == operation.orgId && $0.orchestratorId == operation.orchestratorId && ($0.state == .pending || $0.state == .uncertain)
        }) else { throw ArmadaError.conflict }
        try saveOperations(pendingOperations + [operation])
        return operation
    }
    private func update(_ operation: PendingOrchestratorOperation) throws {
        guard let prior = pendingOperations.first(where: { $0.id == operation.id }) else { throw CancellationError() }
        if prior.state == .succeeded || prior.state == .failed { return }
        let monotonic = operation.updating(state: operation.state, receipt: operation.receipt,
            attempts: max(prior.dispatchCount, operation.dispatchCount))
        try saveOperations(pendingOperations.map { $0.id == operation.id ? monotonic : $0 })
    }
    private func selectedOrganization() throws -> String {
        guard isSignedIn else { throw ArmadaError.signedOut }
        guard let selectedOrgID else { throw ArmadaError.forbidden }
        return selectedOrgID
    }
    private func safeID(_ id: String) throws -> String {
        // Encode path components by rejecting separators, dot segments and query syntax.
        guard !id.isEmpty, id.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else { throw ArmadaError.invalidResponse }
        return id
    }
    private func pageQuery(_ org: String, _ cursor: String?, _ limit: Int) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "orgId", value: org), URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return items
    }
}
