import Foundation
import Testing
@testable import ArmadaKit

// The server's responses, built from `@armada/core`'s own types with every value each enum-like field
// takes today (`packages/core/test/ios-wire-contract.test.ts` keeps the fixture in sync). Each field
// is then given a value the server does not send yet: the app must still decode every row (#962).

private func fixture() -> [String: Any] {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/server-wire-contract.json")
    return try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
}
private let future = "value_added_after_this_build"

private func response(_ name: String) -> Any { (fixture()["responses"] as! [String: Any])[name]! }

/// Sets `value` at a dotted path; `*` is every element of an array, and an element without the
/// remaining path is left as it is. The caller requires at least one replacement.
private func replacing(_ path: ArraySlice<Substring>, in json: Any, with value: Any, replacements: inout Int) -> Any {
    guard let key = path.first else { replacements += 1; return value }
    let rest = path.dropFirst()
    if key == "*", let array = json as? [Any] { return array.map { replacing(rest, in: $0, with: value, replacements: &replacements) } }
    if let index = Int(key), var array = json as? [Any], array.indices.contains(index) {
        array[index] = replacing(rest, in: array[index], with: value, replacements: &replacements); return array
    }
    if var object = json as? [String: Any], let child = object[String(key)] {
        object[String(key)] = replacing(rest, in: child, with: value, replacements: &replacements); return object
    }
    return json
}

private func decode<T: Decodable>(_ type: T.Type, _ json: Any, setting path: String? = nil) throws -> T {
    var replacements = 0
    let body = path.map { replacing($0.split(separator: ".")[...], in: json, with: future, replacements: &replacements) } ?? json
    if let path { try #require(replacements > 0, "Fixture has no field at \(path)") }
    return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: body))
}

@Test func everyValueTheServerSendsTodayDecodes() throws {
    let values = fixture()["values"] as! [String: [String]]
    #expect(values.count >= 15)
    let list = try decode(OrchestratorList.self, response("orchestratorList"))
    #expect(Set(list.items.map(\.state.rawValue)) == Set(values["orchestratorState"]!))
    #expect(Set(list.items.map(\.continuity.rawValue)) == Set(values["orchestratorContinuity"]!))
    #expect(Set(list.items.compactMap(\.configuration.size?.rawValue)) == Set(values["machineSize"]!))
    // Today's values all have a name in this build; only a later one is `unknown`.
    #expect(!list.items.contains { if case .unknown = $0.state { true } else { false } })
    let detail = try decode(OrchestratorDetail.self, response("orchestratorDetail"))
    #expect(Set(detail.operations.map(\.kind.rawValue)) == Set(values["operationKind"]!))
    #expect(Set(detail.operations.map(\.state.rawValue)) == Set(values["operationState"]!))
    let events = try decode(OrchestratorEventPage.self, response("orchestratorEvents"))
    // `connections` events are kept as unknown variants: this build does not show them.
    let unnamed = events.events.compactMap { if case .unknown(let kind, _) = $0.body { kind } else { nil } }
    #expect(Set(unnamed) == ["connections"])
    let sandboxes = try decode(SandboxMetadataPage.self, response("sandboxList"))
    #expect(Set(sandboxes.sandboxes.map(\.status)) == Set(values["sandboxStatus"]!))
    let logs = try decode(SandboxEventPage.self, response("sandboxEvents"))
    #expect(!logs.events.contains { if case .unknown = $0.body { true } else { false } })
}

@Test func aValueAddedLaterToAnOrchestratorKeepsTheWholeList() throws {
    let json = response("orchestratorList")
    let count = ((json as! [String: Any])["items"] as! [Any]).count
    for path in ["items.*.state", "items.*.continuity", "items.*.configuration.provider",
                 "items.*.configuration.harness", "items.*.configuration.size"] {
        let list = try decode(OrchestratorList.self, json, setting: path)
        #expect(list.items.count == count, "\(path)")
    }
    let state = try decode(OrchestratorList.self, json, setting: "items.*.state")
    #expect(state.items.allSatisfy { $0.state == .unknown(future) })
    let continuity = try decode(OrchestratorList.self, json, setting: "items.*.continuity")
    #expect(continuity.items.allSatisfy { $0.continuity == .unknown(future) })
    let size = try decode(OrchestratorList.self, json, setting: "items.*.configuration.size")
    #expect(size.items.allSatisfy { $0.configuration.size == .unknown(future) })
}

@Test func aValueAddedLaterToAnOrchestratorKeepsItsDetail() throws {
    let json = response("orchestratorDetail")
    for path in ["orchestrator.state", "orchestrator.continuity", "operations.*.kind", "operations.*.state",
                 "waits.*.kind", "delegation.scopes.*", "delegation.childPolicy"] {
        let detail = try decode(OrchestratorDetail.self, json, setting: path)
        #expect(detail.operations.count == 28 && detail.waits.count == 4, "\(path)")
    }
    let blocked = try decode(OrchestratorDetail.self, json, setting: "orchestrator.blockedReason")
    #expect(blocked.orchestrator.blockedReason == future)
    let errors = try decode(OrchestratorDetail.self, json, setting: "operations.*.errorCode")
    #expect(!errors.operations.isEmpty && errors.operations.allSatisfy { $0.errorCode == future })
    let operations = try decode(OrchestratorDetail.self, json, setting: "operations.*.state").operations
    #expect(operations.allSatisfy { $0.state == .unknown(future) })
    // Neither terminal nor open: the rules that read it keep it from looking settled or ready.
    let controls = try OrchestratorControls(detail: decode(OrchestratorDetail.self, json, setting: "orchestrator.state"), agentWorking: false)
    #expect(controls.phase == .unknown(future) && !controls.canMessage && !controls.canStop)
}

@Test func aValueAddedLaterToAnEventKeepsThePage() throws {
    let json = response("orchestratorEvents")
    let count = ((json as! [String: Any])["events"] as! [Any]).count
    for path in ["events.*.kind", "events.*.state", "events.*.continuity", "events.*.operation.kind",
                 "events.*.operation.state", "events.*.status", "events.*.lease.kind", "events.*.event.kind",
                 "events.*.event.status", "events.*.event.textMode"] {
        let page = try decode(OrchestratorEventPage.self, json, setting: path)
        #expect(page.events.count == count && page.cursor == "cursor-0001", "\(path)")
    }
    let reasons = try decode(OrchestratorEventPage.self, json, setting: "events.*.event.reason").events.compactMap { event -> String? in
        if case .agent(let agent) = event.body, case .prompt(_, _, let reason) = agent.body { return reason }
        return nil
    }
    #expect(!reasons.isEmpty && reasons.allSatisfy { $0 == future })
    let modes = try decode(OrchestratorEventPage.self, json, setting: "events.*.event.mode").events.compactMap { event -> String? in
        if case .agent(let agent) = event.body, case .steer(_, let mode) = agent.body { return mode }
        return nil
    }
    #expect(!modes.isEmpty && modes.allSatisfy { $0 == future })
    let errors = try decode(OrchestratorEventPage.self, json, setting: "events.*.operation.errorCode").events.compactMap { event -> String? in
        if case .operation(let operation) = event.body { return operation.errorCode }
        return nil
    }
    #expect(!errors.isEmpty && errors.allSatisfy { $0 == future })
    let kinds = try decode(OrchestratorEventPage.self, json, setting: "events.*.kind")
    #expect(kinds.events.allSatisfy { if case .unknown(future, _) = $0.body { true } else { false } })
    let states = try decode(OrchestratorEventPage.self, json, setting: "events.*.state")
    #expect(states.events.contains { if case .state(.unknown(future), _) = $0.body { true } else { false } })
}

@Test func aValueAddedLaterToASandboxKeepsTheListAndItsEvents() throws {
    let list = response("sandboxList")
    for path in ["sandboxes.*.status", "sandboxes.*.provider", "sandboxes.*.harness", "sandboxes.*.machineSize"] {
        let page = try decode(SandboxMetadataPage.self, list, setting: path)
        #expect(page.sandboxes.count == page.total, "\(path)")
    }
    let logs = response("sandboxEvents")
    let reasons = try decode(SandboxEventPage.self, logs, setting: "events.*.reason").events.compactMap { event -> String? in
        if case .prompt(_, _, let reason) = event.body { return reason }
        return nil
    }
    #expect(!reasons.isEmpty && reasons.allSatisfy { $0 == future })
    let modes = try decode(SandboxEventPage.self, logs, setting: "events.*.mode").events.compactMap { event -> String? in
        if case .steer(_, let mode) = event.body { return mode }
        return nil
    }
    #expect(!modes.isEmpty && modes.allSatisfy { $0 == future })
    let count = ((logs as! [String: Any])["events"] as! [Any]).count
    for path in ["events.*.kind", "events.*.status", "events.*.textMode"] {
        let page = try decode(SandboxEventPage.self, logs, setting: path)
        #expect(page.events.count == count, "\(path)")
    }
}

@Test func aSavedCommandWhoseReceiptStateIsUnknownStaysUncertain() throws {
    let pending = PendingOrchestratorOperation(orgId: "org-a", orchestratorId: "orc-a", action: .stop, route: "r", body: Data())
    let receipt = try decode(OrchestratorDetail.self, response("orchestratorDetail"), setting: "operations.*.state").operations[0]
    let updated = pending.updating(state: receipt.state, receipt: receipt)
    #expect(updated.state == .uncertain && !updated.canDiscard)
}

// Usage is additive interior data which this iPhone build does not present. All three
// affected read envelopes must decode with populated, partial, legacy or absent usage.
@Test func sessionUsageCountersDoNotBreakIPhoneReadResponses() throws {
    let usage = #"{"computeSeconds":12,"turnCount":1,"turns":[{"promptId":"p1","model":"gpt-6.1-sol","inputTokens":100,"outputTokens":5,"cachedTokens":20,"cacheWriteTokens":30,"reasoningTokens":null}],"tokenTotals":{"inputTokens":100,"outputTokens":5,"cachedTokens":20,"cacheWriteTokens":30,"reasoningTokens":null}}"#
    let full = try JSONSerialization.jsonObject(with: Data(usage.utf8)) as! [String: Any]
    var partial = full
    partial["tokenTotals"] = ["inputTokens": NSNull(), "outputTokens": NSNull(), "cachedTokens": NSNull(), "cacheWriteTokens": NSNull()]
    partial["turns"] = [["promptId": "p1", "model": "gpt-6.1-sol", "inputTokens": NSNull(), "outputTokens": NSNull(), "cachedTokens": NSNull(), "unavailableReason": ["code": "native_start_unobserved", "message": "No matching native start was observed."]]]
    for counters in [full as Any, partial as Any, NSNull()] {
        var list = response("sandboxList") as! [String: Any]
        let originalRows = list["sandboxes"] as! [[String: Any]]
        list["sandboxes"] = originalRows.map { row in var row = row; row["usage"] = counters; return row }
        #expect(try decode(SandboxMetadataPage.self, list).sandboxes.count == originalRows.count)

        var orchestrator = response("orchestratorDetail") as! [String: Any]
        orchestrator["usage"] = ["own": counters, "children": partial["tokenTotals"]!]
        #expect(try decode(OrchestratorDetail.self, orchestrator).orchestrator.id == (try decode(OrchestratorDetail.self, response("orchestratorDetail"))).orchestrator.id)

        let detail: [String: Any] = ["id": "sandbox-1", "harness": "codex", "status": "running", "conversationIds": ["c1"], "settled": true, "usage": counters]
        let decoded = try decode(SandboxDetail.self, detail)
        #expect(decoded.id == "sandbox-1" && decoded.admission == .open)
    }
}
