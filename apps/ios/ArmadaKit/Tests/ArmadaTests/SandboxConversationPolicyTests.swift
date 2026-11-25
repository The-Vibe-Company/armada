import Foundation
import Testing

@Test func optimisticWorkingColdOpenTransitionsPollSkippingAndStreamingScroll() {
    let idle = SandboxState(status: .ready, statusReason: nil, turn: nil, admission: .open, canStop: true, isWorking: false)
    #expect(SandboxConversationPolicy.isWorking(state: idle, feedHasLoaded: true, feedRunning: false, listedStatus: .ready, listedWorking: false, hasActivePending: true))
    #expect(SandboxConversationPolicy.isWorking(state: nil, feedHasLoaded: false, feedRunning: false, listedStatus: .ready, listedWorking: false, hasActivePending: true))
    #expect(!SandboxConversationPolicy.isWorking(state: idle, feedHasLoaded: true, feedRunning: false, listedStatus: .ready, listedWorking: false, hasActivePending: false))
    for s in [SandboxStatus.ready, .running, .stopped] { #expect(SandboxConversationPolicy.coldOpenUnavailableReason(listedStatus: s) == nil) }
    #expect(SandboxConversationPolicy.coldOpenUnavailableReason(listedStatus: .starting)?.contains("Starting") == true)
    #expect(SandboxConversationPolicy.coldOpenUnavailableReason(listedStatus: .stopping) == "Stopping…")
    #expect(SandboxConversationPolicy.coldOpenUnavailableReason(listedStatus: .failed)?.contains("failed") == true)
    #expect(SandboxConversationPolicy.coldOpenUnavailableReason(listedStatus: .deleted)?.contains("deleted") == true)
    #expect(SandboxConversationPolicy.coldOpenUnavailableReason(listedStatus: nil) == "Loading…")

    let base = SandboxState(status: .starting, statusReason: nil, turn: nil, admission: .starting, canStop: true, isWorking: false)
    let run = SandboxConversationPolicy.applyTransition(status: .running, statusReason: nil, to: base, failureExplanation: nil)
    #expect(run.state.status == .running && run.state.isWorking && run.state.admission == .turnRunning && run.needsFullReload)
    let fail = SandboxConversationPolicy.applyTransition(status: .failed, statusReason: "expired", to: run.state, failureExplanation: "Sandbox expired.")
    #expect(fail.state.admission == .failed && !fail.state.isWorking && !fail.state.canStop && fail.state.failureExplanation == "Sandbox expired." && fail.needsFullReload)
    let del = SandboxConversationPolicy.applyTransition(status: .deleted, statusReason: nil, to: run.state, failureExplanation: nil)
    #expect(del.state.admission == .deleted && !del.state.canStop && !del.needsFullReload)
    #expect(SandboxConversationPolicy.shouldSkipStatusPoll(state: run.state, stopping: false, feedIsLive: true, sseConnected: true, liveAge: nil, fullAge: .seconds(10)))
    #expect(!SandboxConversationPolicy.shouldSkipStatusPoll(state: run.state, stopping: false, feedIsLive: true, sseConnected: true, liveAge: nil, fullAge: .seconds(60)))
    #expect(!SandboxConversationPolicy.shouldSkipStatusPoll(state: base, stopping: false, feedIsLive: true, sseConnected: true, liveAge: .seconds(1), fullAge: .seconds(1)))

    let s1 = ConversationItem(key: "m1", at: .now, promptID: "p1", kind: .assistant(text: "Hel", streaming: true, model: nil))
    let s2 = ConversationItem(key: "m1", at: .now, promptID: "p1", kind: .assistant(text: "Hello", streaming: true, model: nil))
    let done = ConversationItem(key: "m1", at: .now, promptID: "p1", kind: .assistant(text: "Hello", streaming: false, model: nil))
    let next = ConversationItem(key: "u2", at: .now, promptID: "p2", kind: .user(text: "Next", status: .running, reason: nil))
    #expect(!SandboxConversationPolicy.shouldAnimateTailScroll(previous: nil, current: s1, reduceMotion: false))
    #expect(!SandboxConversationPolicy.shouldAnimateTailScroll(previous: s1, current: s2, reduceMotion: false))
    #expect(!SandboxConversationPolicy.shouldAnimateTailScroll(previous: s2, current: done, reduceMotion: false))
    #expect(SandboxConversationPolicy.shouldAnimateTailScroll(previous: done, current: next, reduceMotion: false))
    #expect(!SandboxConversationPolicy.shouldAnimateTailScroll(previous: done, current: next, reduceMotion: true))
}
