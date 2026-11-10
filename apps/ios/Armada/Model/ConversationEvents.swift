import Foundation

/// A JSON value carried untouched from the wire (tool inputs and outputs). Rendered literally,
/// never interpreted as Markdown or HTML.
indirect enum JSONValue: Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null
}

struct ToolCall: Hashable, Sendable {
    let id: String
    var name: String
    var input: JSONValue?
    /// Absent until the tool finished.
    var result: ToolResult?
}

struct ToolResult: Hashable, Sendable {
    let output: JSONValue
    let isError: Bool
}

/// The common `AgentEvent` stream of `packages/core/src/provider.ts`, the same for every harness
/// and provider.
struct AgentEvent: Hashable, Sendable {
    enum TextMode: String, Hashable, Sendable {
        case delta
        case snapshot
    }

    enum Body: Hashable, Sendable {
        case prompt(text: String, status: PromptStatus, reason: String?)
        case message(
            text: String,
            partial: Bool,
            messageID: String?,
            textMode: TextMode?,
            model: String?,
            tools: [ToolCall]
        )
        case steer(text: String, mode: String?)
        /// A kind this version does not know: kept whole so no news is lost.
        case other(type: String)
    }

    let id: String
    let at: Date
    let conversationID: String?
    let promptID: String?
    let body: Body
}

/// `OrchestratorEvent` v1: the owner-scoped durable mirror served with an opaque cursor.
struct OrchestratorEvent: Identifiable, Hashable, Sendable {
    enum Body: Hashable, Sendable {
        case agent(AgentEvent)
        case state(OrchestratorState, OrchestratorContinuity)
        case operation(OperationSummary)
        case wait(WaitLease, status: String)
        case child(sandboxID: String, operationID: String)
        /// A newer event kind: preserved, never dropped silently.
        case unknown(kind: String)
    }

    let id: String
    let at: Date
    let revision: Int
    let body: Body
}

struct OrchestratorEventPage: Sendable {
    let events: [OrchestratorEvent]
    /// Opaque, poll-safe forward cursor: the live frontier. Nil only on an empty first read.
    let cursor: String?
    /// Relative to the read's direction: newer events (forward) or older ones (backward).
    let hasMore: Bool
    /// Backward reads only: continues before the oldest event of the page.
    var olderCursor: String? = nil
}
