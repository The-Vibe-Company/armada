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
    /// UI must consult durable command state, not infer admission from an HTTP status.
    public var canDiscard: Bool {
        state == .succeeded || state == .failed || (state == .pending && receipt == nil && dispatchCount == 0)
    }
    public var rejectedBeforeAdmission: Bool { state == .failed && receipt == nil }
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
        // A receipt state this build does not know proves neither outcome: keep the command as
        // uncertain, so it still blocks a duplicate and can only be forgotten with a warning.
        if case .unknown = state { self.state = .uncertain } else { self.state = state }
        self.receipt = receipt; self.attempts = attempts ?? prior.attempts
    }
    func updating(state: OrchestratorOperationState, receipt: OrchestratorOperation? = nil, attempts: Int? = nil) -> Self {
        Self(self, state: state, receipt: receipt, attempts: attempts)
    }
}

extension ArmadaError {
    /// A structured 4xx refusal from the orchestrator handler. The server answers one only before its
    /// create or mutation reservation commits (an unknown outcome is `outcome_unknown`, a 503), so a
    /// first attempt refused this way was never admitted, exactly like `invalid_request`.
    var isStructuredRefusal: Bool { if case .refused = self { true } else { false } }
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
    /// `backward` reads the latest page (or the one before `cursor`), as `sandboxEvents` does (#812).
    /// A page refused for its byte budget (one event over 256 KiB) is read once more with
    /// `largestEventPageBytes`, as `sandboxEvents` does.
    public func orchestratorEvents(id: String, cursor: String? = nil, limit: Int = 100, backward: Bool = false) async throws -> OrchestratorEventPage {
        guard (1...500).contains(limit) else { throw ArmadaError.invalidResponse }
        var query = pageQuery(try selectedOrganization(), cursor, limit)
        if backward { query.append(URLQueryItem(name: "direction", value: "backward")) }
        let route = try "orchestrators/" + safeID(id) + "/events"
        let result: OrchestratorEventPage
        do {
            result = try await authenticatedRequest(route, method: "GET", query: query)
        } catch ArmadaError.invalidRequest {
            query.append(URLQueryItem(name: "maxBytes", value: String(Self.largestEventPageBytes)))
            result = try await authenticatedRequest(route, method: "GET", query: query)
        }
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
        activeSubmissions[operationID, default: 0] += 1
        defer {
            let remaining = (activeSubmissions[operationID] ?? 1) - 1
            activeSubmissions[operationID] = remaining == 0 ? nil : remaining
            if remaining == 0 { activeTerminalReceipts[operationID] = nil }
        }
        if let receipt = terminalReceipt(operationID) { return receipt }
        guard pending.state != .failed else { throw ArmadaError.invalidRequest }
        let capabilities = try await orchestratorCapabilities()
        guard capabilities.enabled else { throw ArmadaError.unavailable }
        // Recheck after suspension: signout/account switching cannot submit old work.
        guard isSignedIn, selectedOrgID == pending.orgId else { throw CancellationError() }
        if let receipt = terminalReceipt(operationID) { return receipt }
        guard let current = pendingOperations.first(where: { $0.id == operationID }) else { throw CancellationError() }
        if let receipt = current.receipt, receipt.state == .succeeded || receipt.state == .failed { return receipt }
        guard current.state != .failed else { throw ArmadaError.invalidRequest }
        let attempt = current.dispatchCount + 1
        try update(current.updating(state: .uncertain, receipt: current.receipt, attempts: attempt)) // persist BEFORE external effects
        do {
            let receipt: OrchestratorOperation = try await authenticatedRequest(pending.route, method: "POST", body: pending.body, key: pending.key)
            guard receipt.version == 1, pending.action.receiptKinds.contains(receipt.kind),
                  current.receipt == nil || current.receipt?.id == receipt.id,
                  pending.orchestratorId == nil || receipt.orchestratorId == pending.orchestratorId else { throw ArmadaError.invalidResponse }
            try update(pending.updating(state: receipt.state, receipt: receipt))
            return pendingOperations.first(where: { $0.id == operationID })?.receipt ?? receipt
        } catch let error as ArmadaError where error == .invalidRequest || error.isStructuredRefusal {
            if let receipt = terminalReceipt(operationID) { return receipt }
            // The actual handler's structured invalid_request response is pre-effect rejection.
            // Preserve any concurrent terminal receipt; otherwise allow explicit discard.
            if attempt == 1, pendingOperations.first(where: { $0.id == operationID })?.dispatchCount == attempt {
                try update(pending.updating(state: .failed))
            }
            // A refused retry cannot establish the earlier unknown outcome.
            throw error
        } catch {
            if let receipt = terminalReceipt(operationID) { return receipt }
            // Previously persisted uncertain bytes remain even if the response was lost.
            throw error
        }
    }
    /// Read the existing owner detail surface only when an exact server receipt is known.
    /// No-ID/lost-response commands cannot be correlated by action/revision alone.
    public func reconcileOrchestratorOperation(_ operationID: UUID) async throws -> OrchestratorOperation? {
        guard let pending = pendingOperations.first(where: { $0.id == operationID }),
              pending.orgId == (try selectedOrganization()) else { throw ArmadaError.forbidden }
        if let terminal = terminalReceipt(operationID) { return terminal }
        guard let prior = pending.receipt else { return nil }
        let detail = try await orchestratorDetail(id: prior.orchestratorId)
        return try absorb(detail, into: operationID)
    }

    /// Records the saved operation's receipt as `detail` reports it. Nil when the detail does not
    /// carry that exact receipt (another orchestrator, organization, revision or kind).
    private func absorb(_ detail: OrchestratorDetail, into operationID: UUID) throws -> OrchestratorOperation? {
        guard let pending = pendingOperations.first(where: { $0.id == operationID }) else { throw CancellationError() }
        guard selectedOrgID == pending.orgId, isSignedIn else { throw CancellationError() }
        if let terminal = terminalReceipt(operationID) { return terminal }
        guard let prior = pending.receipt,
              detail.orchestrator.id == prior.orchestratorId,
              detail.orchestrator.configuration.orgId == pending.orgId,
              let receipt = detail.operations.first(where: { $0.id == prior.id }),
              receipt.version == 1, pending.action.receiptKinds.contains(receipt.kind),
              receipt.orchestratorId == prior.orchestratorId,
              receipt.revision == prior.revision else { return nil }
        try update(pending.updating(state: receipt.state, receipt: receipt))
        return terminalReceipt(operationID) ?? receipt
    }

    /// Follows an accepted create until it settles: reads the new orchestrator's detail, records its
    /// create receipt, and sleeps `OrchestratorPolling`'s delay between reads (backing off after a
    /// failed read). Sends nothing. Returns `.ready` only once the server reports the create
    /// succeeded and the orchestrator past `creating`; `.failed` with a plain sentence otherwise.
    /// `sleep` is the clock (injected by tests); cancelling the task stops following.
    /// Throws `ArmadaError.conflict` when the saved operation is not an accepted create, and
    /// rethrows a read failure that waiting cannot fix (signed out, no access, unsupported answer)
    /// or the last one after `maxFailedReads` failed reads in a row (the saved command stays for
    /// the list to settle later).
    public func followOrchestratorCreate(
        _ operationID: UUID,
        maxFailedReads: Int = 8,
        sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) async throws -> OrchestratorCreateProgress {
        var failures = 0
        while true {
            try Task.checkCancellation()
            guard let pending = pendingOperations.first(where: { $0.id == operationID }),
                  pending.orgId == (try selectedOrganization()),
                  pending.action == .create, let receipt = pending.receipt else { throw ArmadaError.conflict }
            var delay = OrchestratorPolling.settling
            do {
                let detail = try await orchestratorDetail(id: receipt.orchestratorId)
                let settled = try absorb(detail, into: operationID)
                if let settled, settled.state == .failed {
                    return .failed(OrchestratorExplanation.text(for: settled.errorCode ?? detail.orchestrator.blockedReason ?? "create_failed"))
                }
                let progress = OrchestratorCreateProgress(detail: detail)
                if case .failed = progress { return progress }
                // Ready only once its own receipt, when the detail lists it, is no longer open.
                if progress == .ready, settled?.state == .succeeded { return .ready }
                failures = 0
                delay = OrchestratorPolling.detailDelay(state: detail.orchestrator.state.rawValue,
                                                        hasOpenOperation: true, consecutiveFailures: 0)
                    ?? OrchestratorPolling.settling
            } catch let error as ArmadaError where error == .unavailable || error == .http(429) {
                // Offline, a server error or rate limiting: wait longer and read again, up to a bound.
                failures += 1
                if failures >= maxFailedReads { throw error }
                delay = OrchestratorPolling.backoff(failures)
            }
            try await sleep(delay)
        }
    }

    /// Explicit user-authorized local abandonment only. Does not cancel the server
    /// action or prove it never happened. A new command can duplicate its effects.
    public func discardUncertainOrchestratorOperation(_ operationID: UUID, acknowledgingPossibleEffects: Bool) throws {
        guard acknowledgingPossibleEffects,
              let pending = pendingOperations.first(where: { $0.id == operationID }),
              pending.orgId == (try selectedOrganization()),
              activeSubmissions[operationID] == nil,
              pending.state == .uncertain else { throw ArmadaError.conflict }
        try saveOperations(pendingOperations.filter { $0.id != operationID })
    }

    private func terminalReceipt(_ id: UUID) -> OrchestratorOperation? {
        guard let receipt = activeTerminalReceipts[id] ?? pendingOperations.first(where: { $0.id == id })?.receipt,
              receipt.state == .succeeded || receipt.state == .failed else { return nil }
        return receipt
    }
    /// A never-dispatched local command, terminal receipt or proven initial
    /// validation rejection may be discarded. Server-pending/uncertain effects cannot.
    public func discardOrchestratorOperation(_ operationID: UUID) throws {
        guard let operation = pendingOperations.first(where: { $0.id == operationID }),
              operation.canDiscard else { throw ArmadaError.conflict }
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
        if let receipt = monotonic.receipt, receipt.state == .succeeded || receipt.state == .failed,
           activeSubmissions[operation.id] != nil {
            activeTerminalReceipts[operation.id] = receipt
        }
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
