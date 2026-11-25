import Foundation

/// Pure conversation state, optimistic working, composer availability, and scroll policies.
enum SandboxConversationPolicy {
    static func isWorking(state: SandboxState?, feedHasLoaded: Bool, feedRunning: Bool, listedStatus: SandboxStatus?, listedWorking: Bool, hasActivePending: Bool) -> Bool {
        if hasActivePending { return true }
        if let state { return state.isWorking || feedRunning }
        return feedHasLoaded ? feedRunning : (listedWorking || listedStatus == .running)
    }
    static func coldOpenUnavailableReason(listedStatus: SandboxStatus?) -> String? {
        switch listedStatus {
        case .ready, .running, .stopped: nil
        case .starting: "Starting. You can write once it is ready."
        case .stopping: "Stopping…"
        case .failed: "This sandbox failed. Launch a new sandbox to continue."
        case .deleted: "This sandbox was deleted. Its conversation is no longer available."
        case .other, nil: "Loading…"
        }
    }
    static func shouldSkipStatusPoll(state: SandboxState?, stopping: Bool, feedIsLive: Bool, sseConnected: Bool, liveAge: Duration?, fullAge: Duration?) -> Bool {
        guard let state, !stopping, state.status != .starting, state.status != .stopping, feedIsLive, let fullAge, fullAge < .seconds(60) else { return false }
        return sseConnected || (liveAge.map { $0 < .seconds(15) } ?? false)
    }
    static func applyTransition(status: SandboxStatus, statusReason: String?, to current: SandboxState, now: Date = .now, failureExplanation: String?) -> (state: SandboxState, needsFullReload: Bool) {
        let expired = current.expiresAt.map { $0 <= now } == true; let readyWorking = status == .ready && current.turn?.status.isActive == true
        let (admission, canStop, isWorking, reload): (SandboxState.Admission, Bool, Bool, Bool) = switch status {
        case .starting: (.starting, true, false, false)
        case .ready: (expired ? .expired : (readyWorking ? .turnRunning : .open), true, readyWorking, current.status == .starting || current.isWorking)
        case .running: (expired ? .expired : .turnRunning, true, true, current.status == .starting)
        case .stopping: (.stopping, false, current.isWorking, false)
        case .stopped: (expired ? .expired : .open, false, false, true)
        case .failed: (.failed, false, false, true)
        case .deleted: (.deleted, false, false, false)
        case .other: (.unknownStatus, false, false, true)
        }
        return (SandboxState(status: status, statusReason: statusReason, turn: isWorking ? current.turn : nil, admission: admission, canStop: canStop, isWorking: isWorking, expiresAt: current.expiresAt, preservationWarning: current.preservationWarning, failureExplanation: status == .failed ? failureExplanation : current.failureExplanation), reload)
    }
    static func shouldAnimateTailScroll(previous: ConversationItem?, current: ConversationItem?, reduceMotion: Bool) -> Bool {
        guard !reduceMotion else { return false }
        if case .assistant(_, let streaming, _) = current?.kind, streaming { return false }
        return previous?.id != current?.id
    }
}
