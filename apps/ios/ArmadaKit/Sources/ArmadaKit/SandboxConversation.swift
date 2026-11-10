import Foundation

/// The latest turn of a sandbox, as `sandbox/detail` reports it (`prompt` of the MCP `status` tool).
public struct SandboxTurn: Decodable, Sendable, Equatable {
    public let promptId: String
    public let conversationId: String?
    /// `running`, `finished`, `interrupted` or `failed`. Unknown values are kept as sent.
    public let state: String
    /// Safe, server-written reason of a failed or interrupted turn.
    public let reason: String?
}

/// Interior detail of one sandbox: `POST /api/v1/sandbox/detail`, the same route `armada status`
/// uses. Only the owner or a current admin receives it (#680); the server decides on every read.
/// Fields the app does not need (golden, repository directory, legacy visibility) are not decoded.
public struct SandboxDetail: Decodable, Sendable, Equatable {
    public let id: String
    public let harness: String
    public let model: String?
    public let reasoningEffort: String?
    /// `starting`, `ready`, `running`, `stopping`, `stopped`, `failed` or `deleted`.
    public let status: String
    public let statusReason: String?
    public let conversationIds: [String]
    public let expiresAt: String?
    public let prompt: SandboxTurn?
    /// True when the agent is not working.
    public let settled: Bool

    /// Whether a new prompt can be offered now. The server reauthorizes and may still refuse.
    public var admission: SandboxPromptAdmission {
        switch status {
        case "deleted": .deleted
        case "failed": .failed
        case "starting": .starting
        case "stopping": .stopping
        case "ready", "running", "stopped":
            // A stopped sandbox resumes on its next prompt; a working agent is steered, not sent to.
            settled && prompt?.state != "running" ? .open : .turnRunning
        default: .unknownStatus
        }
    }

    /// Whether stopping is meaningful now (the machine is up or coming up).
    public var canStop: Bool { ["starting", "ready", "running"].contains(status) }

    /// The agent is working on a turn.
    public var isWorking: Bool { !settled || prompt?.state == "running" }
}

public enum SandboxPromptAdmission: Sendable, Equatable {
    case open, turnRunning, starting, stopping, failed, deleted, unknownStatus
}

/// One page of a sandbox's `AgentEvent`s, oldest first: `POST /api/v1/logs/read` (`armada logs`).
/// The cursor is opaque and passed back unchanged; an event read twice keeps its id.
public struct SandboxEventPage: Decodable, Sendable {
    public let events: [AgentEvent]
    public let cursor: String?
    public let hasMore: Bool
}

/// The server's acceptance of a prompt: `POST /api/v1/sandbox/send` (`armada send`).
public struct SandboxPromptReceipt: Decodable, Sendable, Equatable {
    public let id: String
    public let promptId: String
    public let conversationId: String
    public let status: String
}

/// `POST /api/v1/sandbox/stop` (`armada stop`): the disk and conversations are kept.
public struct SandboxStopReceipt: Decodable, Sendable, Equatable {
    public let id: String
    public let status: String
}

/// How a failed sandbox mutation must be presented. `sandbox/send` carries no idempotency key, so
/// an outcome that is not a definite refusal is unconfirmed and is never retried automatically:
/// resending could run the prompt twice. The conversation shows the prompt if it was delivered.
public enum SandboxMutationFailure: Sendable, Equatable {
    case signedOut
    /// Missing, concealed or not the caller's to open (403/404).
    case noAccess
    /// Definitely not applied: a known pre-admission refusal code (400) or the sandbox's state (409).
    case refused
    /// May have been applied: transport failure, a server error or an unrecognized 400.
    case unconfirmed

    public static func classify(_ error: Error) -> SandboxMutationFailure {
        switch error as? ArmadaError {
        case .signedOut: .signedOut
        case .forbidden, .http(404): .noAccess
        case .invalidRequest, .conflict: .refused
        default: .unconfirmed
        }
    }
}

/// Merges re-read events into a stream. The sandbox event contract re-sends an event with the same
/// id and a newer body (a prompt that finished, a message that grew), so a known id is replaced in
/// place and a new id is appended, in server order. Returns whether anything changed.
public enum EventStream {
    public static func merge<Event: Identifiable & Equatable>(_ incoming: [Event], into events: inout [Event]) -> Bool {
        var index = Dictionary(events.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first })
        var changed = false
        for event in incoming {
            if let position = index[event.id] {
                if events[position] != event { events[position] = event; changed = true }
            } else {
                index[event.id] = events.count
                events.append(event)
                changed = true
            }
        }
        return changed
    }
}

extension ArmadaClient {
    /// Interior detail for the owner or a current admin. Never called for a list row to enrich it.
    public func sandboxDetail(id: String) async throws -> SandboxDetail {
        struct Read: Encodable, Sendable { let id: String; let org: String }
        let result: SandboxDetail = try await post("sandbox/detail", Read(id: try sandboxID(id), org: try sandboxOrganization()))
        guard result.id.lowercased() == id.lowercased() else { throw ArmadaError.invalidResponse }
        return result
    }

    /// One page of events after `cursor` (from the start when nil), in server order. With `all`, the
    /// server reads on from `cursor` for as many pages as one response allows (`armada logs --all`)
    /// and returns them together with the cursor after the last one; `hasMore` stays true when even
    /// that was not the end.
    public func sandboxEvents(id: String, cursor: String? = nil, all: Bool = false) async throws -> SandboxEventPage {
        struct Read: Encodable, Sendable { let id: String; let org: String; let cursor: String?; let all: Bool? }
        if let cursor, cursor.isEmpty { throw ArmadaError.invalidResponse }
        return try await post("logs/read", Read(id: try sandboxID(id), org: try sandboxOrganization(), cursor: cursor, all: all ? true : nil))
    }

    /// Sends one prompt as a new turn. Sent once: a failure is classified with
    /// `SandboxMutationFailure.classify` and never resent by this client.
    public func sendSandboxPrompt(id: String, text: String) async throws -> SandboxPromptReceipt {
        struct Send: Encodable, Sendable { let id: String; let org: String; let prompt: String }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ArmadaError.invalidRequest }
        let result: SandboxPromptReceipt = try await post("sandbox/send", Send(id: try sandboxID(id), org: try sandboxOrganization(), prompt: text))
        guard result.id.lowercased() == id.lowercased() else { throw ArmadaError.invalidResponse }
        return result
    }

    /// Stops the machine; its disk and conversations are kept and a later prompt resumes it.
    public func stopSandbox(id: String) async throws -> SandboxStopReceipt {
        struct Stop: Encodable, Sendable { let id: String; let org: String }
        let result: SandboxStopReceipt = try await post("sandbox/stop", Stop(id: try sandboxID(id), org: try sandboxOrganization()))
        guard result.id.lowercased() == id.lowercased() else { throw ArmadaError.invalidResponse }
        return result
    }

    private func sandboxOrganization() throws -> String {
        guard isSignedIn else { throw ArmadaError.signedOut }
        guard let selectedOrgID else { throw ArmadaError.forbidden }
        return selectedOrgID
    }

    /// Armada sandbox ids are UUIDs; anything else is refused before a request is made.
    private func sandboxID(_ id: String) throws -> String {
        guard UUID(uuidString: id) != nil else { throw ArmadaError.invalidRequest }
        return id
    }
}
