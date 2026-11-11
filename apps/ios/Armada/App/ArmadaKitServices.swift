import ArmadaKit
import Foundation

/// The presentation services over the actual `ArmadaKit` client (#690). This file and
/// `AppModel.swift` are the only places that import ArmadaKit (besides the pure
/// `ArmadaKit.EventStream` merge rule `ConversationFeed` imports alone). Kit types are always written
/// `ArmadaKit.X` because the app declares presentation types with the same names.
///
struct ArmadaKitServices: SandboxService {
    let client: ArmadaClient

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

    func sandboxEvents(id: String, orgID: String, cursor: String?, backward: Bool) async throws(ServiceFailure) -> ConversationEventPage {
        try await requireOrganization(orgID)
        do {
            let page = try await client.sandboxEvents(id: id, cursor: cursor, backward: backward)
            return ConversationEventPage(
                events: page.events.map(Self.agentEvent),
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
        if ArmadaServerFailure.underlying(error) == .conflict {
            return Self.explained(.rejected("This sandbox can't be read in its current state. Pull to refresh."), by: error)
        }
        return readFailure(error)
    }

    private static func sandboxMutationFailure(_ error: any Error, refused: String) -> ServiceFailure {
        let failure: ServiceFailure = switch SandboxMutationFailure.classify(error) {
        case .signedOut: .signedOut
        case .noAccess: .noAccess
        case .refused: .rejected(refused)
        case .unconfirmed: .uncertain
        }
        return explained(failure, by: error)
    }

    static func explained(_ failure: ServiceFailure, by error: any Error) -> ServiceFailure {
        guard let server = error as? ArmadaServerFailure else { return failure }
        return .explained(failure, server.explanation)
    }

    // MARK: Gates

    private func requireOrganization(_ orgID: String) async throws(ServiceFailure) {
        guard await client.selectedOrgID == orgID else { throw .noAccess }
    }

    // MARK: Failures

    private static func readFailure(_ error: any Error) -> ServiceFailure {
        if let server = error as? ArmadaServerFailure {
            return .explained(readFailure(server.cause), server.explanation)
        }
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
        case .conflict: return .rejected("The resource changed. Refresh and try again.")
        case .invalidRequest: return .rejected("Armada refused this request.")
        case .invalidResponse: return .rejected("Armada returned a response this app version doesn't understand.")
        case .secureStorage: return .rejected("This device's secure storage is unavailable.")
        case .invalidOrigin, .http: return .rejected("The request could not be completed.")
        }
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
            turn: value.prompt.map { SandboxTurnState(promptID: $0.promptId, status: PromptStatus(rawValue: $0.state), reason: $0.reason, requestedModel: $0.requestedModel, observedModel: $0.observedModel, modelSelectionReason: $0.modelSelectionReason, modelSelectionMessage: $0.modelSelectionMessage) },
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
