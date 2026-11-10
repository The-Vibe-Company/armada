import Foundation

/// What a person's message is meant to do: start a new turn, or reach the turn that runs now.
public enum FollowUpIntent: String, Sendable, Equatable {
    case message
    case steer
}

/// How one composer entry reaches an agent (#847). The person writes one thing; whether it goes
/// as a steer or a new message is decided from the conversation as read just before sending, never
/// from what the screen showed when they started typing. If the turn ended in between and the
/// server refuses the steer because no turn runs (`no_running_turn`, a definite refusal: nothing
/// was delivered), the same text is sent once more as a new message. Nothing is resent when the
/// outcome is unknown: that stays the caller's unconfirmed state.
public enum FollowUp {
    /// The receipt code of a steer refused because the conversation had no running turn.
    public static let noRunningTurn = "no_running_turn"

    /// The intent to send now: a steer only when the person chose it and a turn runs now.
    public static func intent(requested: FollowUpIntent, turnRunning: Bool) -> FollowUpIntent {
        requested == .steer && turnRunning ? .steer : .message
    }

    /// A settled receipt that means: this steer reached no turn, and nothing was delivered.
    public static func refusedForNoRunningTurn(kind: String, state: String, errorCode: String?) -> Bool {
        kind == FollowUpIntent.steer.rawValue && state == OrchestratorOperationState.failed.rawValue
            && errorCode == noRunningTurn
    }

    /// What `deliver` did.
    public struct Delivery<Receipt: Sendable>: Sendable {
        /// What finally reached the agent: `.message` after a refused steer.
        public let intent: FollowUpIntent
        public let receipt: Receipt
        /// The steer was refused because no turn ran, and the text was sent as a new message.
        public let resentAsMessage: Bool
    }

    /// Sends one entry and, when it was a steer the server refused because no turn ran, sends the
    /// same text once as a new message. `send` is the first request (a fresh steer or message, or a
    /// retry of exactly the same request); `sendAsMessage` prepares and sends a new message. A
    /// failure is thrown unchanged and never followed by another request. Runs on the main actor,
    /// with the screen whose state the requests update.
    @MainActor
    public static func deliver<Receipt: Sendable, Failure: Error>(
        as intent: FollowUpIntent,
        send: () async throws(Failure) -> Receipt,
        refusedForNoRunningTurn: (Receipt) -> Bool,
        sendAsMessage: () async throws(Failure) -> Receipt
    ) async throws(Failure) -> Delivery<Receipt> {
        let receipt = try await send()
        guard intent == .steer, refusedForNoRunningTurn(receipt) else {
            return Delivery(intent: intent, receipt: receipt, resentAsMessage: false)
        }
        return Delivery(intent: .message, receipt: try await sendAsMessage(), resentAsMessage: true)
    }
}

/// Whether the agent is working, for the "is working" indicator and the steer choice. The event
/// stream reports which turns are queued or running; a steer refused because no turn runs is the
/// server's proof that what it lists is stale, even when the stream has not caught up (#847).
/// Those turns stop counting at once, each until the stream reports a new status for it (a queued
/// turn that starts running counts again) or a turn it did not list.
public struct TurnActivity: Sendable, Equatable {
    /// The status (`queued` or `running`) of each turn (prompt id) the stream reports as active.
    public private(set) var reported: [String: String] = [:]
    /// Reported turns and statuses the server has since contradicted.
    public private(set) var ended: [String: String] = [:]

    public init() {}

    /// The stream was read: these turns are active in it, with their status.
    public mutating func streamReported(_ active: [String: String]) {
        reported = active
        ended = ended.filter { active[$0.key] == $0.value }
    }

    /// The server refused a steer because no turn runs: what the stream reports now is stale.
    public mutating func noTurnRuns() {
        ended = reported
    }

    public var isWorking: Bool { reported.contains { ended[$0.key] != $0.value } }
}
