import CryptoKit
import Foundation
import Testing

private func message(
    _ id: String, text: String, messageID: String? = "reply", mode: AgentEvent.TextMode? = .delta,
    partial: Bool = true, model: String? = nil, tools: [ToolCall] = [],
    conversation: String = "c", prompt: String = "p", at: TimeInterval = 0
) -> AgentEvent {
    AgentEvent(id: id, at: Date(timeIntervalSince1970: at), conversationID: conversation, promptID: prompt,
               body: .message(text: text, partial: partial, messageID: messageID, textMode: mode, model: model, tools: tools))
}

@Test func snapshotsAndDeltasPreserveOrderMetadataToolsAndLegacyMessages() throws {
    let call = ToolCall(id: "read", name: "Read", input: .object(["path": .string("README.md")]), result: nil)
    let result = ToolCall(id: "read", name: "tool_result", input: nil, result: ToolResult(output: .string("done"), isError: false))
    let events = [
        AgentEvent(id: "start", at: .distantPast, conversationID: "c", promptID: "p",
                   body: .prompt(text: "Make it clear", status: .running, reason: nil)),
        message("a", text: "Hel", model: "initial", tools: [call], at: 1),
        message("b", text: "lo", at: 2),
        message("other", text: "Other", messageID: "other", mode: nil, partial: false, at: 3),
        message("snapshot", text: "replacement", mode: .snapshot, model: "updated", at: 4),
        message("final", text: " tail", partial: false, tools: [result], at: 5),
        AgentEvent(id: "finish", at: .distantFuture, conversationID: "c", promptID: "p",
                   body: .prompt(text: "", status: .finished, reason: nil)),
        message("legacy-part", text: "obsolete", messageID: nil),
        message("legacy-final", text: "legacy final", messageID: nil, partial: false),
        AgentEvent(id: "technical", at: .distantFuture, conversationID: "c", promptID: "p", body: .other(type: "checkpoint"))
    ]
    let projection = ConversationProjection.project(events)
    try #require(projection.items.count == 5)
    #expect(projection.items.map(\.key) == ["prompt:p", "message:c:p:reply", "tool:read", "message:c:p:other", "event:legacy-final"])
    #expect(projection.items[0].kind == .user(text: "Make it clear", status: .finished, reason: nil))
    #expect(projection.items[1].kind == .assistant(text: "replacement tail", streaming: false, model: "updated"))
    #expect(projection.items[1].at == Date(timeIntervalSince1970: 1))
    #expect(projection.items[2].kind == .tool(ToolActivity(call: ToolCall(id: "read", name: "Read", input: call.input, result: result.result), at: Date(timeIntervalSince1970: 1))))
    #expect(projection.items[3].kind == .assistant(text: "Other", streaming: false, model: nil))
    #expect(projection.items[4].kind == .assistant(text: "legacy final", streaming: false, model: nil))
    #expect(projection.activeTurns.isEmpty)
    #expect(projection.technicalCount == 1)
}

@Test func messageIdentityAndUnicodeFragmentsRemainScopedToTheirTurn() {
    let projection = ConversationProjection.project([
        message("a", text: "e", conversation: "one", prompt: "first"),
        message("b", text: "separate", conversation: "two", prompt: "second"),
        message("c", text: "\u{301} 👩", conversation: "one", prompt: "first"),
        message("d", text: "‍💻", partial: false, conversation: "one", prompt: "first")
    ])
    #expect(projection.items.count == 2)
    guard case .assistant(let text, let streaming, _) = projection.items[0].kind else {
        Issue.record("Expected the first assistant message"); return
    }
    #expect(Array(text.utf8) == Array("e\u{301} 👩‍💻".utf8))
    #expect(!streaming)
    #expect(projection.items[1].kind == .assistant(text: "separate", streaming: true, model: nil))
}

@Test func longStreamProjectionProducesCompleteTextAndReportsComponentTiming() {
    let count = 4_000
    let fragment = String(repeating: "abcdefgh", count: 16)
    let events = (0..<count).map { index in
        message("event-\(index)", text: fragment, partial: index != count - 1, model: index == 0 ? "fixture" : nil, at: TimeInterval(index))
    }
    var samples: [Double] = []
    var projections: [Conversation] = []
    let clock = ContinuousClock()
    for _ in 0..<5 {
        let start = clock.now
        let projection = ConversationProjection.project(events)
        let elapsed = start.duration(to: clock.now).components
        samples.append(Double(elapsed.seconds) * 1_000 + Double(elapsed.attoseconds) / 1e15)
        projections.append(projection)
    }
    let expected = SHA256.hash(data: Data(String(repeating: fragment, count: count).utf8))
    for projection in projections {
        #expect(projection.items.count == 1)
        guard let item = projection.items.first, case .assistant(let text, let streaming, let model) = item.kind else {
            Issue.record("Expected one complete assistant message"); return
        }
        #expect(SHA256.hash(data: Data(text.utf8)) == expected)
        #expect(!streaming)
        #expect(model == "fixture")
    }
    #if DEBUG
    let configuration = "debug"
    #else
    let configuration = "release"
    #endif
    print("Projection component: config=\(configuration) events=4000 output_bytes=512000 median_ms=\(String(format: "%.3f", samples.sorted()[2]))")
}
