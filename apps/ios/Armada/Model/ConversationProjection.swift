import Foundation

/// One tool call, merged from every event that carried its id (start, input, result).
struct ToolActivity: Hashable, Sendable {
    var call: ToolCall
    let at: Date
}

/// What a conversation shows, oldest first. Each item has a stable key across polls and replays.
struct ConversationItem: Identifiable, Hashable, Sendable {
    enum Kind: Hashable, Sendable {
        case user(text: String, status: PromptStatus, reason: String?)
        case steer(text: String, mode: String?)
        case assistant(text: String, streaming: Bool, model: String?)
        case tool(ToolActivity)
        case outcome(PromptStatus, reason: String?)
        case notice(ConversationNotice)
    }

    let key: String
    let at: Date
    let promptID: String?
    var kind: Kind

    var id: String { key }
}

/// Orchestrator-level facts the conversation shows inline, compactly.
enum ConversationNotice: Hashable, Sendable {
    case stopped
    case resumed
    case blocked
    case continuityLost
    case operationFailed(OperationKind, code: String?)
    case operationUncertain(OperationKind)
    case childLaunched(sandboxID: String)
    case waiting(kind: String, reason: String, expiresAt: Date)
    case waitExpired(kind: String, reason: String)
}

struct Conversation: Sendable {
    var items: [ConversationItem]
    /// The turns (prompt keys) that are queued or running.
    var runningTurns: Set<String>
    /// A turn is queued or running.
    var running: Bool { !runningTurns.isEmpty }
    /// Events not shown (unknown kinds, status-only prompts), counted for the technical view.
    var technicalCount: Int
}

/// Projects the event stream onto a conversation, with exactly the semantics of the dashboard's
/// `projectChat` (`apps/dashboard/src/lib/chat.ts`):
/// - one user message per prompt (`promptId`), whatever number of status events it has, with the
///   latest status;
/// - one assistant message per `(conversationId, promptId, messageId)`: `delta` text is appended,
///   `snapshot` text replaces it. A message without `messageId` (legacy) stays its own message,
///   except that streamed chunks are dropped once a final message of the same turn follows them;
/// - one tool activity per tool id, its input and result merged from later events;
/// - a failed or interrupted turn ends with its outcome.
/// The event id stays the replay identity: the same events always give the same items and keys.
enum ConversationProjection {
    /// Claude Code reports a tool's result under this name, with the id of the call it answers.
    private static let resultPlaceholder = "tool_result"

    static func project(_ events: [OrchestratorEvent]) -> Conversation {
        var items: [ConversationItem] = []
        var technicalCount = 0
        var promptIndex: [String: Int] = [:]
        var messageIndex: [String: Int] = [:]
        var toolIndex: [String: Int] = [:]
        var legacyChunks: [String: [String]] = [:]
        var superseded = Set<String>()
        var lastState: OrchestratorState?
        var noticeIndex: [String: Int] = [:]
        var hiddenNotices = Set<String>()

        for event in events {
            switch event.body {
            case .agent(let agent):
                project(
                    agent,
                    into: &items,
                    technicalCount: &technicalCount,
                    promptIndex: &promptIndex,
                    messageIndex: &messageIndex,
                    toolIndex: &toolIndex,
                    legacyChunks: &legacyChunks,
                    superseded: &superseded
                )
            case .state(let state, let continuity):
                if let notice = notice(for: state, continuity: continuity, after: lastState) {
                    items.append(ConversationItem(key: "event:\(event.id)", at: event.at, promptID: nil, kind: .notice(notice)))
                }
                lastState = state
            case .operation(let operation):
                // One notice per operation id, updated in place: an unconfirmed operation that
                // later fails reads as failed, and one that succeeds stops being shown.
                let key = "operation:\(operation.id)"
                let notice: ConversationNotice?
                switch operation.state {
                case .failed: notice = .operationFailed(operation.kind, code: operation.errorCode)
                case .uncertain: notice = .operationUncertain(operation.kind)
                case .pending, .succeeded, .other: notice = nil
                }
                upsertNotice(notice, key: key, at: event.at, items: &items, index: &noticeIndex, hidden: &hiddenNotices)
            case .wait(let lease, let status):
                // One notice per lease id: active shows it, expired updates it, released clears it.
                let key = "wait:\(lease.id)"
                let notice: ConversationNotice?
                switch status {
                case "active": notice = .waiting(kind: lease.kind, reason: lease.reason, expiresAt: lease.expiresAt)
                case "expired": notice = .waitExpired(kind: lease.kind, reason: lease.reason)
                case "released": notice = nil
                default:
                    technicalCount += 1
                    continue
                }
                upsertNotice(notice, key: key, at: event.at, items: &items, index: &noticeIndex, hidden: &hiddenNotices)
            case .child(let sandboxID, _):
                items.append(ConversationItem(
                    key: "event:\(event.id)",
                    at: event.at,
                    promptID: nil,
                    kind: .notice(.childLaunched(sandboxID: sandboxID))
                ))
            case .unknown:
                technicalCount += 1
            }
        }

        let shown = items.filter { item in
            if superseded.contains(item.key) || hiddenNotices.contains(item.key) { return false }
            if case .assistant(let text, let streaming, _) = item.kind, text.isEmpty, !streaming { return false }
            return true
        }

        var lastOfTurn: [String: Int] = [:]
        for (index, item) in shown.enumerated() {
            if let promptID = item.promptID { lastOfTurn[promptID] = index }
        }
        var outcomes: [Int: [ConversationItem]] = [:]
        var runningTurns = Set<String>()
        for index in promptIndex.values.sorted() {
            let prompt = items[index]
            guard case .user(_, let status, let reason) = prompt.kind else { continue }
            if status.isActive { runningTurns.insert(prompt.key) }
            guard status == .failed || status == .interrupted else { continue }
            let position = prompt.promptID.flatMap { lastOfTurn[$0] }
                ?? shown.firstIndex(where: { $0.key == prompt.key })
            guard let position else { continue }
            outcomes[position, default: []].append(ConversationItem(
                key: "outcome:\(prompt.key)",
                at: prompt.at,
                promptID: prompt.promptID,
                kind: .outcome(status, reason: reason)
            ))
        }

        var result: [ConversationItem] = []
        result.reserveCapacity(shown.count + outcomes.count)
        for (index, item) in shown.enumerated() {
            result.append(item)
            result.append(contentsOf: outcomes[index] ?? [])
        }
        return Conversation(items: result, runningTurns: runningTurns, technicalCount: technicalCount)
    }

    // swiftlint:disable:next function_parameter_count
    private static func project(
        _ event: AgentEvent,
        into items: inout [ConversationItem],
        technicalCount: inout Int,
        promptIndex: inout [String: Int],
        messageIndex: inout [String: Int],
        toolIndex: inout [String: Int],
        legacyChunks: inout [String: [String]],
        superseded: inout Set<String>
    ) {
        let turnKey = "\(event.conversationID ?? "")\u{0}\(event.promptID ?? "")"
        switch event.body {
        case .prompt(let text, let status, let reason):
            let key = event.promptID.map { "prompt:\($0)" } ?? "event:\(event.id)"
            if let index = promptIndex[key], case .user(let knownText, _, let knownReason) = items[index].kind {
                let nextText = knownText.isEmpty && !text.isEmpty ? text : knownText
                let nextReason: String?
                if let reason, !reason.isEmpty {
                    nextReason = reason
                } else {
                    nextReason = status == .failed ? knownReason : nil
                }
                items[index].kind = .user(text: nextText, status: status, reason: nextReason)
            } else if !text.isEmpty || event.promptID != nil {
                promptIndex[key] = items.count
                items.append(ConversationItem(
                    key: key,
                    at: event.at,
                    promptID: event.promptID,
                    kind: .user(text: text, status: status, reason: reason?.isEmpty == false ? reason : nil)
                ))
            } else {
                technicalCount += 1
            }

        case .steer(let text, let mode):
            items.append(ConversationItem(
                key: "event:\(event.id)",
                at: event.at,
                promptID: event.promptID,
                kind: .steer(text: text, mode: mode)
            ))

        case .message(let text, let partial, let messageID, let textMode, let model, let tools):
            if let messageID {
                let key = "message:\(event.conversationID ?? ""):\(event.promptID ?? ""):\(messageID)"
                let mode = textMode ?? .snapshot
                if let index = messageIndex[key], case .assistant(let known, _, let knownModel) = items[index].kind {
                    items[index].kind = .assistant(
                        text: mode == .delta ? known + text : text,
                        streaming: partial,
                        model: model ?? knownModel
                    )
                } else {
                    messageIndex[key] = items.count
                    items.append(ConversationItem(
                        key: key,
                        at: event.at,
                        promptID: event.promptID,
                        kind: .assistant(text: text, streaming: partial, model: model)
                    ))
                }
            } else if !text.isEmpty {
                let key = "event:\(event.id)"
                if partial {
                    legacyChunks[turnKey, default: []].append(key)
                } else {
                    for chunk in legacyChunks[turnKey] ?? [] { superseded.insert(chunk) }
                    legacyChunks[turnKey] = nil
                }
                items.append(ConversationItem(
                    key: key,
                    at: event.at,
                    promptID: event.promptID,
                    kind: .assistant(text: text, streaming: partial, model: model)
                ))
            }
            for call in tools {
                let key = "tool:\(call.id)"
                if let index = toolIndex[key], case .tool(var activity) = items[index].kind {
                    if activity.call.name == resultPlaceholder, call.name != resultPlaceholder {
                        activity.call.name = call.name
                    }
                    if let input = call.input { activity.call.input = input }
                    if let result = call.result { activity.call.result = result }
                    items[index].kind = .tool(activity)
                } else {
                    toolIndex[key] = items.count
                    items.append(ConversationItem(
                        key: key,
                        at: event.at,
                        promptID: event.promptID,
                        kind: .tool(ToolActivity(call: call, at: event.at))
                    ))
                }
            }

        case .other:
            technicalCount += 1
        }
    }

    /// Shows, updates or hides the single notice that `key` identifies, keeping its first position.
    private static func upsertNotice(
        _ notice: ConversationNotice?,
        key: String,
        at: Date,
        items: inout [ConversationItem],
        index: inout [String: Int],
        hidden: inout Set<String>
    ) {
        if let position = index[key] {
            if let notice {
                items[position].kind = .notice(notice)
                hidden.remove(key)
            } else {
                hidden.insert(key)
            }
        } else if let notice {
            index[key] = items.count
            items.append(ConversationItem(key: key, at: at, promptID: nil, kind: .notice(notice)))
        }
    }

    private static func notice(
        for state: OrchestratorState,
        continuity: OrchestratorContinuity,
        after previous: OrchestratorState?
    ) -> ConversationNotice? {
        if continuity == .lost { return .continuityLost }
        switch state {
        case .stopped: return previous == .stopped ? nil : .stopped
        case .blocked: return previous == .blocked ? nil : .blocked
        case .ready: return previous == .resuming || previous == .stopped ? .resumed : nil
        case .creating, .stopping, .resuming, .other: return nil
        }
    }
}

/// Tool payload rendering helpers, with the dashboard's `toolSummary` and `toolText` semantics.
enum ToolPayloadText {
    /// The few words that say what a tool call is about: its command, path, pattern or query.
    static func summary(_ input: JSONValue?) -> String {
        guard let input else { return "" }
        switch input {
        case .string(let value):
            return oneLine(value)
        case .object(let record):
            for field in ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description", "prompt"] {
                switch record[field] {
                case .string(let value) where !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                    return oneLine(value)
                case .array(let parts):
                    let strings = parts.compactMap { part -> String? in
                        if case .string(let value) = part { return value }
                        return nil
                    }
                    if strings.count == parts.count { return oneLine(strings.joined(separator: " ")) }
                default:
                    continue
                }
            }
            return ""
        default:
            return ""
        }
    }

    /// A tool's input or result as text: strings as they are, text blocks joined, anything else
    /// as indented JSON.
    static func text(_ value: JSONValue?) -> String {
        guard let value else { return "" }
        switch value {
        case .null:
            return ""
        case .string(let text):
            return text
        case .array(let blocks):
            let texts = blocks.compactMap(textBlock)
            // As in the dashboard, an empty array is "every block is text" and reads as nothing.
            if texts.count == blocks.count { return texts.joined(separator: "\n") }
            return json(value, indent: 0)
        case .object:
            return textBlock(value) ?? json(value, indent: 0)
        case .number, .bool:
            return json(value, indent: 0)
        }
    }

    private static func textBlock(_ value: JSONValue) -> String? {
        guard case .object(let record) = value,
              case .string("text")? = record["type"],
              case .string(let text)? = record["text"] else { return nil }
        return text
    }

    private static func oneLine(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return line.count > 140 ? String(line.prefix(139)) + "…" : line
    }

    private static func json(_ value: JSONValue, indent: Int) -> String {
        let pad = String(repeating: "  ", count: indent)
        let inner = String(repeating: "  ", count: indent + 1)
        switch value {
        case .null: return "null"
        case .bool(let flag): return flag ? "true" : "false"
        case .number(let number):
            return number.rounded() == number && abs(number) < 1e15 ? String(Int64(number)) : String(number)
        case .string(let text): return quoted(text)
        case .array(let values):
            guard !values.isEmpty else { return "[]" }
            let body = values.map { inner + json($0, indent: indent + 1) }.joined(separator: ",\n")
            return "[\n\(body)\n\(pad)]"
        case .object(let record):
            guard !record.isEmpty else { return "{}" }
            let body = record.keys.sorted().map { key in
                "\(inner)\(quoted(key)): \(json(record[key] ?? .null, indent: indent + 1))"
            }.joined(separator: ",\n")
            return "{\n\(body)\n\(pad)}"
        }
    }

    private static func quoted(_ text: String) -> String {
        var escaped = ""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": escaped += "\\\""
            case "\\": escaped += "\\\\"
            case "\n": escaped += "\\n"
            case "\t": escaped += "\\t"
            case "\r": escaped += "\\r"
            default:
                if scalar.value < 0x20 {
                    escaped += String(format: "\\u%04x", scalar.value)
                } else {
                    escaped.unicodeScalars.append(scalar)
                }
            }
        }
        return "\"\(escaped)\""
    }
}
