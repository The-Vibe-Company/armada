import ArmadaKit
import Foundation

/// The presentation services over the actual `ArmadaKit` client (#690). This file and
/// `AppModel.swift` are the only places that import ArmadaKit (besides the pure
/// `ArmadaKit.EventStream` merge rule `ConversationFeed` imports alone). Kit types are always written
/// `ArmadaKit.X` because the app declares presentation types with the same names.
///
/// What ArmadaKit publishes is used as-is: capabilities, list, detail, events, the durable
/// prepare/submit command store, #680 sandbox metadata and a sandbox's interior (detail, events,
/// send, stop), and for create the server's pairs and model catalog, goldens and model accounts.
struct ArmadaKitServices: OrchestratorService, SandboxService {
    let client: ArmadaClient

    // MARK: Reads

    func list(orgID: String, cursor: String?) async throws(ServiceFailure) -> OrchestratorPage {
        try await requireOrganization(orgID)
        try await requireEnabled()
        do {
            let page = try await client.orchestrators(cursor: cursor, limit: 25)
            return OrchestratorPage(items: try page.items.map(Self.summary), cursor: page.cursor)
        } catch {
            throw Self.readFailure(error)
        }
    }

    func detail(id: String) async throws(ServiceFailure) -> OrchestratorDetail {
        do {
            let detail = try await client.orchestratorDetail(id: id)
            return OrchestratorDetail(
                summary: try Self.summary(detail.orchestrator),
                operations: detail.operations.map(Self.operation),
                waits: try detail.waits.map(Self.lease),
                delegation: try detail.delegation.map { delegation in
                    DelegationSummary(
                        scopes: delegation.scopes,
                        expiresAt: try Self.date(delegation.expiresAt),
                        revokedAt: try delegation.revokedAt.map(Self.date)
                    )
                },
                childSandboxIDs: detail.childSandboxIds
            )
        } catch {
            throw Self.readFailure(error)
        }
    }

    func events(id: String, cursor: String?, backward: Bool) async throws(ServiceFailure) -> OrchestratorEventPage {
        do {
            let page = try await client.orchestratorEvents(id: id, cursor: cursor, limit: 100, backward: backward)
            let supported = page.events.filter { event in
                switch event.body {
                case .unknown: return false
                case .agent(let agent):
                    if case .unknown = agent.body { return false }
                    return true
                default: return true
                }
            }
            return OrchestratorEventPage(events: try supported.map(Self.event), cursor: page.cursor, hasMore: page.hasMore, olderCursor: page.olderCursor)
        } catch {
            throw Self.readFailure(error)
        }
    }

    /// Capabilities (pairs and per-harness catalog), goldens and model accounts, all from the server
    /// over the CLI's routes. Nothing is offered that the server did not report.
    func createOptions(orgID: String) async throws(ServiceFailure) -> CreateOptions {
        try await requireOrganization(orgID)
        let capabilities = try await fetchCapabilities()
        guard capabilities.enabled || !(capabilities.pairs ?? []).isEmpty else {
            throw .unavailable(ArmadaKit.OrchestratorExplanation.text(for: capabilities.reason ?? "native_conformance_required"))
        }
        do {
            async let goldens = client.goldens()
            async let accounts = client.modelAccounts()
            return CreateOptions(catalog: ArmadaKit.OrchestratorCreateCatalog(
                capabilities: capabilities, goldens: try await goldens, accounts: try await accounts
            ))
        } catch {
            throw Self.readFailure(error)
        }
    }

    // MARK: Commands

    func prepareCreate(_ request: OrchestratorCreateRequest) async throws(ServiceFailure) -> String {
        try await requireOrganization(request.orgID)
        // Never save a command the server would not accept now: a saved command can only be
        // cleared once it has a final outcome.
        try await requireEnabled()
        let configuration = request.configuration
        do {
            return try await client.prepareOrchestratorCreate(configuration).id.uuidString
        } catch {
            throw await prepareFailure(error, orgID: request.orgID, orchestratorID: nil)
        }
    }

    func prepareMutation(
        _ action: OrchestratorAction,
        orchestratorID: String,
        expectedRevision: Int
    ) async throws(ServiceFailure) -> String {
        let kitAction: ArmadaKit.OrchestratorAction
        let text: String?
        switch action {
        case .message(let value): kitAction = .message; text = value
        case .steer(let value): kitAction = .steer; text = value
        case .stop: kitAction = .stop; text = nil
        case .resume: kitAction = .resume; text = nil
        case .recover: kitAction = .recover; text = nil
        }
        try await requireEnabled()
        do {
            return try await client.prepareOrchestratorMutation(
                id: orchestratorID,
                action: kitAction,
                expectedRevision: expectedRevision,
                text: text
            ).id.uuidString
        } catch {
            let orgID = await client.selectedOrgID ?? ""
            throw await prepareFailure(error, orgID: orgID, orchestratorID: orchestratorID)
        }
    }

    func submit(handle: String) async throws(ServiceFailure) -> OperationSummary {
        guard let id = UUID(uuidString: handle) else { throw .rejected("That request is no longer saved on this device.") }
        do {
            if let receipt = await client.pendingOperations.first(where: { $0.id == id })?.receipt,
               receipt.state == .succeeded || receipt.state == .failed {
                // SDK validates the current organization even for cached results.
                return Self.operation(try await client.submitOrchestratorOperation(id))
            }
            if let receipt = try await client.reconcileOrchestratorOperation(id),
               receipt.state == .succeeded || receipt.state == .failed {
                return Self.operation(receipt)
            }
            let receipt = try await client.submitOrchestratorOperation(id)
            if receipt.state == .uncertain { throw ServiceFailure.uncertain }
            // Keep terminal knowledge available to concurrent same-handle callers.
            // It does not block preparing a new command; explicit cleanup is separate.
            return Self.operation(receipt)
        } catch {
            if let receipt = await client.pendingOperations.first(where: { $0.id == id })?.receipt,
               receipt.state == .succeeded || receipt.state == .failed {
                do { return Self.operation(try await client.submitOrchestratorOperation(id)) }
                catch { throw await submitFailure(error, id: id) }
            }
            throw await submitFailure(error, id: id)
        }
    }

    func unresolved(orgID: String, orchestratorID: String?) async -> UnresolvedOperation? {
        if let operation = await client.pendingOperations.first(where: {
            $0.orgId == orgID && $0.orchestratorId == orchestratorID && ($0.state == .pending || $0.state == .uncertain)
        }) {
            _ = try? await client.reconcileOrchestratorOperation(operation.id)
        }
        let saved = await client.pendingOperations.first { operation in
            operation.orgId == orgID && operation.orchestratorId == orchestratorID
                && (operation.state == .pending || operation.state == .uncertain)
        }
        return saved.map {
            UnresolvedOperation(
                handle: $0.id.uuidString,
                kind: OperationKind(rawValue: $0.action.rawValue),
                receipt: $0.receipt.map(Self.operation)
            )
        }
    }

    func discard(handle: String) async {
        guard let id = UUID(uuidString: handle) else { return }
        try? await client.discardOrchestratorOperation(id)
    }

    func discardUncertain(handle: String) async throws(ServiceFailure) {
        guard let id = UUID(uuidString: handle) else { throw .rejected("This request is no longer saved.") }
        do {
            // Try a final read first; disappearance/mismatch is never rejection evidence.
            _ = try? await client.reconcileOrchestratorOperation(id)
            if let saved = await client.pendingOperations.first(where: { $0.id == id }), saved.canDiscard {
                try await client.discardOrchestratorOperation(id)
            } else {
                try await client.discardUncertainOrchestratorOperation(id, acknowledgingPossibleEffects: true)
            }
        } catch { throw Self.readFailure(error) }
    }

    func settle(handle: String) async {
        guard let id = UUID(uuidString: handle) else { return }
        _ = try? await client.reconcileOrchestratorOperation(id)
    }

    // MARK: Sandboxes

    func list(orgID: String, page: Int) async throws(ServiceFailure) -> SandboxPage {
        try await requireOrganization(orgID)
        do {
            let result = try await client.sandboxMetadata(page: page, limit: 25)
            return SandboxPage(items: try result.sandboxes.map(Self.sandbox), total: result.total, nextPage: result.nextPage)
        } catch ArmadaError.invalidResponse {
            // ArmadaKit decodes only the #680 allowlisted DTO; an older server's list is refused.
            throw .unavailable("This Armada server doesn't offer the organization sandbox list yet.")
        } catch {
            throw Self.readFailure(error)
        }
    }

    func sandboxState(id: String, orgID: String) async throws(ServiceFailure) -> SandboxState {
        try await requireOrganization(orgID)
        do {
            return Self.state(try await client.sandboxDetail(id: id))
        } catch {
            throw Self.sandboxReadFailure(error)
        }
    }

    func sandboxEvents(id: String, orgID: String, cursor: String?, backward: Bool) async throws(ServiceFailure) -> OrchestratorEventPage {
        try await requireOrganization(orgID)
        do {
            let page = try await client.sandboxEvents(id: id, cursor: cursor, backward: backward)
            // A sandbox stream has no orchestrator revision; every event is an agent event.
            return OrchestratorEventPage(
                events: page.events.map { OrchestratorEvent(id: $0.id, at: Date(timeIntervalSince1970: $0.at / 1_000), revision: 0, body: .agent(Self.agentEvent($0))) },
                cursor: page.cursor,
                hasMore: page.hasMore,
                olderCursor: page.olderCursor
            )
        } catch {
            throw Self.sandboxReadFailure(error)
        }
    }

    func sendPrompt(sandboxID: String, orgID: String, text: String) async throws(ServiceFailure) -> SandboxPromptAcceptance {
        try await requireOrganization(orgID)
        do {
            let receipt = try await client.sendSandboxPrompt(id: sandboxID, text: text)
            return SandboxPromptAcceptance(promptID: receipt.promptId, status: PromptStatus(rawValue: receipt.status))
        } catch {
            throw Self.sandboxMutationFailure(error, refused: "Armada refused this prompt. The sandbox's latest state is shown; your text is kept.")
        }
    }

    func stopSandbox(id: String, orgID: String) async throws(ServiceFailure) -> SandboxStatus {
        try await requireOrganization(orgID)
        do {
            return SandboxStatus(rawValue: try await client.stopSandbox(id: id).status)
        } catch {
            throw Self.sandboxMutationFailure(error, refused: "Armada refused to stop this sandbox. Its latest state is shown.")
        }
    }

    /// Reads have no revision: a 409 is the sandbox's state, not another person's edit.
    private static func sandboxReadFailure(_ error: any Error) -> ServiceFailure {
        if case .conflict? = error as? ArmadaError {
            return .rejected("This sandbox can't be read in its current state. Pull to refresh.")
        }
        return readFailure(error)
    }

    private static func sandboxMutationFailure(_ error: any Error, refused: String) -> ServiceFailure {
        switch SandboxMutationFailure.classify(error) {
        case .signedOut: .signedOut
        case .noAccess: .noAccess
        case .refused: .rejected(refused)
        case .unconfirmed: .uncertain
        }
    }

    // MARK: Gates

    private func requireOrganization(_ orgID: String) async throws(ServiceFailure) {
        guard await client.selectedOrgID == orgID else { throw .noAccess }
    }

    /// The server's own capability decides. Today's handler answers `enabled: false`
    /// (`native_conformance_required`); that is shown, never worked around.
    private func requireEnabled() async throws(ServiceFailure) {
        let capabilities = try await fetchCapabilities()
        guard capabilities.enabled else {
            throw .unavailable(
                "Orchestrators aren't enabled on this Armada server yet. They appear here once the server enables them."
            )
        }
    }

    private func fetchCapabilities() async throws(ServiceFailure) -> ArmadaKit.OrchestratorCapabilities {
        do {
            return try await client.orchestratorCapabilities()
        } catch ArmadaError.http(404), ArmadaError.http(405), ArmadaError.http(501) {
            throw .unavailable("This Armada server doesn't offer orchestrators yet.")
        } catch {
            throw Self.readFailure(error)
        }
    }

    // MARK: Failures

    private static func readFailure(_ error: any Error) -> ServiceFailure {
        if let failure = error as? ServiceFailure { return failure }
        if error is CancellationError { return .offline }
        guard let armada = error as? ArmadaError else { return .offline }
        switch armada {
        case .emailCodeRefused: return .rejected(armada.localizedDescription)
        case .signedOut: return .signedOut
        case .forbidden, .http(404): return .noAccess
        case .http(405), .http(501):
            return .unavailable("This Armada server doesn't offer this yet.")
        case .unavailable, .http(429): return .offline
        case .conflict: return .staleRevision
        case .invalidRequest: return .rejected("Armada refused this request.")
        case .invalidResponse: return .rejected("Armada returned a response this app version doesn't understand.")
        case .secureStorage: return .rejected("This device's secure storage is unavailable.")
        case .invalidOrigin, .http: return .rejected("The request could not be completed.")
        }
    }

    /// Prepare is local: nothing was sent. A conflict means another command for the same target is
    /// still open on this device.
    private func prepareFailure(_ error: any Error, orgID: String, orchestratorID: String?) async -> ServiceFailure {
        guard let armada = error as? ArmadaError else { return .rejected("The request could not be saved.") }
        switch armada {
        case .conflict:
            let open = await unresolved(orgID: orgID, orchestratorID: orchestratorID)
            if open?.receipt != nil {
                return .rejected("Armada is still processing the previous request. Try again when it finishes.")
            }
            return .rejected("An earlier request is still unconfirmed. Retry it before sending another.")
        case .signedOut: return .signedOut
        case .forbidden: return .noAccess
        default: return .rejected("The request could not be saved on this device.")
        }
    }

    /// The current durable journal, not an HTTP status, decides whether a request
    /// is safely discardable. Generic409 can follow effects; a refused retry does
    /// not resolve earlier ambiguity. Never advertise a new-key retry in that case.
    private func submitFailure(_ error: any Error, id: UUID) async -> ServiceFailure {
        if let failure = error as? ServiceFailure {
            switch failure {
            case .signedOut, .noAccess, .unavailable: return failure
            default: break
            }
        }
        if let armada = error as? ArmadaError, armada == .signedOut { return .signedOut }
        // Absence after concurrent cleanup is not proof of non-admission.
        guard let saved = await client.pendingOperations.first(where: { $0.id == id }) else { return .uncertain }
        if let armada = error as? ArmadaError {
            switch armada {
            case .forbidden, .http(404): return .noAccess
            case .conflict, .invalidRequest, .http(400):
                let neverDispatched = saved.state == .pending && saved.receipt == nil && saved.canDiscard
                // Permission to clean up a succeeded receipt is NOT rejection evidence.
                guard saved.rejectedBeforeAdmission || neverDispatched else { return .uncertain }
                do { try await client.discardOrchestratorOperation(id) }
                catch { return .uncertain }
                return armada == .conflict ? .staleRevision : .rejected("Armada refused this request.")
            default: break
            }
        }
        if saved.state == .pending, saved.receipt == nil { return .offline }
        return .uncertain
    }

    // MARK: Mapping

    private static func summary(_ value: ArmadaKit.Orchestrator) throws(ServiceFailure) -> OrchestratorSummary {
        let configuration = value.configuration
        return OrchestratorSummary(
            id: value.id,
            ownerID: value.ownerId,
            orgID: configuration.orgId,
            name: configuration.name,
            goldenID: configuration.goldenId,
            provider: ProviderID(rawValue: configuration.provider.rawValue),
            harness: Harness(rawValue: configuration.harness.rawValue),
            harnessRaw: configuration.harness.rawValue,
            model: configuration.model,
            reasoningEffort: configuration.reasoningEffort,
            modelAccountID: configuration.modelAccountId,
            repository: configuration.repo,
            idleSeconds: configuration.idleSeconds,
            maxActiveChildren: configuration.maxActiveChildren,
            state: OrchestratorState(rawValue: value.state.rawValue),
            revision: value.revision,
            sandboxID: value.sandboxId,
            continuity: OrchestratorContinuity(rawValue: value.continuity.rawValue),
            createdAt: try date(value.createdAt),
            updatedAt: try date(value.updatedAt),
            lastActivityAt: try date(value.lastActivityAt),
            idleDeadline: try value.idleDeadline.map(date),
            blockedReason: value.blockedReason
        )
    }

    private static func operation(_ value: ArmadaKit.OrchestratorOperation) -> OperationSummary {
        OperationSummary(
            id: value.id,
            orchestratorID: value.orchestratorId,
            kind: OperationKind(rawValue: value.kind.rawValue),
            state: OperationState(rawValue: value.state.rawValue),
            revision: value.revision,
            errorCode: value.errorCode
        )
    }

    private static func lease(_ value: ArmadaKit.OrchestratorWaitLease) throws(ServiceFailure) -> WaitLease {
        WaitLease(
            id: value.id,
            kind: value.kind,
            reference: value.reference,
            reason: value.reason,
            expiresAt: try date(value.expiresAt),
            deadline: try date(value.deadline)
        )
    }

    private static func event(_ value: ArmadaKit.OrchestratorEvent) throws(ServiceFailure) -> OrchestratorEvent {
        let body: OrchestratorEvent.Body
        switch value.body {
        case .agent(let agent): body = .agent(agentEvent(agent))
        case .state(let state, let continuity):
            body = .state(OrchestratorState(rawValue: state.rawValue), OrchestratorContinuity(rawValue: continuity.rawValue))
        case .operation(let operation): body = .operation(Self.operation(operation))
        case .wait(let lease, let status): body = .wait(try Self.lease(lease), status: status)
        case .child(let sandboxID, let operationID): body = .child(sandboxID: sandboxID, operationID: operationID)
        case .unknown(let kind, let payload): body = .unknown(kind: technicalEvent(kind: kind, payload: payload))
        }
        return OrchestratorEvent(id: value.id, at: try date(value.at), revision: value.revision, body: body)
    }

    /// The existing presentation keeps technical entries as text. Retain the
    /// complete JSON there; .unknown/.other are never projected as chat messages.
    private static func technicalEvent(kind: String, payload: ArmadaKit.JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let encoded = (try? encoder.encode(payload)).flatMap { String(data: $0, encoding: .utf8) }
        return "\(kind)\n\(encoded ?? String(reflecting: payload))"
    }

    private static func agentEvent(_ value: ArmadaKit.AgentEvent) -> AgentEvent {
        let body: AgentEvent.Body
        switch value.body {
        case .prompt(let text, let status, let reason):
            body = .prompt(text: text, status: PromptStatus(rawValue: status), reason: reason)
        case .message(let text, let partial, let messageID, let textMode, let model, let tools):
            body = .message(
                text: text,
                partial: partial,
                messageID: messageID,
                textMode: textMode.flatMap(AgentEvent.TextMode.init(rawValue:)),
                model: model,
                tools: tools.map { tool in
                    ToolCall(
                        id: tool.id,
                        name: tool.name,
                        input: tool.input.map(json),
                        result: tool.result.map { ToolResult(output: json($0.output), isError: $0.isError) }
                    )
                }
            )
        case .steer(let text, let mode):
            body = .steer(text: text, mode: mode)
        case .other(let type, _):
            body = .other(type: type)
        case .unknown(let kind, let payload):
            body = .other(type: technicalEvent(kind: kind, payload: payload))
        }
        // AgentEvent.at is milliseconds since the epoch.
        return AgentEvent(
            id: value.id,
            at: Date(timeIntervalSince1970: value.at / 1_000),
            conversationID: value.conversationId,
            promptID: value.promptId,
            body: body
        )
    }

    private static func json(_ value: ArmadaKit.JSONValue) -> JSONValue {
        switch value {
        case .null: .null
        case .bool(let flag): .bool(flag)
        case .number(let number): .number(number)
        case .string(let text): .string(text)
        case .array(let values): .array(values.map(json))
        case .object(let record): .object(record.mapValues(json))
        }
    }

    private static func state(_ value: ArmadaKit.SandboxDetail) -> SandboxState {
        let admission: SandboxState.Admission = switch value.admission {
        case .open: .open
        case .turnRunning: .turnRunning
        case .starting: .starting
        case .stopping: .stopping
        case .failed: .failed
        case .deleted: .deleted
        case .unknownStatus: .unknownStatus
        }
        return SandboxState(
            status: SandboxStatus(rawValue: value.status),
            statusReason: value.statusReason,
            turn: value.prompt.map { SandboxTurnState(promptID: $0.promptId, status: PromptStatus(rawValue: $0.state), reason: $0.reason) },
            admission: admission,
            canStop: value.canStop,
            isWorking: value.isWorking
        )
    }

    private static func sandbox(_ value: ArmadaKit.SandboxMetadata) throws(ServiceFailure) -> SandboxSummary {
        SandboxSummary(
            id: value.id,
            orgID: value.orgId,
            ownerID: value.ownerId,
            provider: ProviderID(rawValue: value.provider),
            providerSandboxID: value.providerSandboxId,
            harness: Harness(rawValue: value.harness),
            harnessRaw: value.harness,
            model: value.model,
            reasoningEffort: value.reasoningEffort,
            status: SandboxStatus(rawValue: value.status),
            createdAt: try date(value.createdAt),
            stoppedAt: try value.stoppedAt.map(date),
            expiresAt: try value.expiresAt.map(date),
            effectiveTTLSeconds: value.effectiveTtlSeconds,
            machineSize: value.machineSize,
            displayLabel: value.displayLabel,
            canOpen: value.canOpen,
            canManage: value.canManage
        )
    }

    /// UTC ISO-8601 with or without fractional seconds, as the server writes them.
    private static func date(_ value: String) throws(ServiceFailure) -> Date {
        if let parsed = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value) { return parsed }
        if let parsed = try? Date.ISO8601FormatStyle().parse(value) { return parsed }
        throw .rejected("Armada returned a date this app version doesn't understand.")
    }
}
