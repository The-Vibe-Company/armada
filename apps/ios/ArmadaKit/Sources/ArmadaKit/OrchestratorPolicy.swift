import Foundation

/// What a person may do with an orchestrator now, derived only from what the server reported. The
/// same rules as the dashboard's `orchestratorControls`: the server refuses any new command while one
/// is pending or unsettled, so none is offered then; a lost conversation is never resumable. The
/// server checks everything again under its revision fence.
public struct OrchestratorControls: Sendable, Equatable {
    public enum Phase: Sendable, Equatable {
        /// The create operation has not settled; nothing can be sent yet.
        case creating
        case ready
        case stopping
        case stopped
        case resuming
        /// Admits no work until resolved; `explanation` is a plain sentence, never a bare code.
        case blocked(explanation: String)
        /// A state this build does not know: shown as itself and never treated as ready.
        case unknown(String)
    }

    /// An operation still open on the server: its kind and whether its outcome is unknown.
    public struct OpenOperation: Sendable, Equatable {
        public let kind: String
        public let uncertain: Bool
    }

    public let phase: Phase
    public let open: OpenOperation?
    public let canMessage: Bool
    public let canSteer: Bool
    public let canStop: Bool
    public let canResume: Bool
    /// Recovery is offered only where the server can settle it: a create still open, or a stop whose
    /// outcome is unknown, at the orchestrator's current revision (blocked), or an unknown first create.
    /// A blocked orchestrator with nothing to settle is not offered recovery: the server would refuse it.
    public let canRecover: Bool
    /// One sentence for the composer when it takes no message; nil when it does.
    public let composerNote: String?

    /// `agentWorking`: a turn of its conversation is queued or running (steer joins it).
    public init(state: String, continuity: String, blockedReason: String?, revision: Int,
                operations: [(kind: String, state: String, revision: Int, errorCode: String?)], agentWorking: Bool) {
        let openOperation = operations.first { $0.state != "succeeded" && $0.state != "failed" }
        open = openOperation.map { OpenOperation(kind: $0.kind, uncertain: $0.state != "pending") }
        let lost = continuity == "lost"
        switch state {
        case "creating": phase = .creating
        case "ready": phase = .ready
        case "stopping": phase = .stopping
        case "stopped": phase = .stopped
        case "resuming": phase = .resuming
        case "blocked": phase = .blocked(explanation: OrchestratorExplanation.text(for: blockedReason ?? "blocked"))
        default: phase = .unknown(state)
        }
        let idle = open == nil
        canMessage = state == "ready" && !lost && idle
        canSteer = canMessage && agentWorking
        canStop = (state == "ready" || state == "blocked") && idle
        canResume = state == "stopped" && continuity == "native" && idle
        let current = operations.filter { $0.revision == revision }
        canRecover = (state == "blocked" && current.contains {
            ($0.kind == "create" && ($0.state == "pending" || $0.state == "uncertain"))
                || ($0.kind == "stop" && $0.state == "uncertain")
                // The server records these create failures as never having started a machine.
                || ($0.kind == "create" && $0.state == "failed" && Self.recoverableCreateFailures.contains($0.errorCode ?? ""))
        }) || (state == "creating" && current.contains { $0.kind == "create" && $0.state == "uncertain" })
        // Why its own create failed, for a stopped or blocked orchestrator that never became ready.
        let createFailure = current.last { $0.kind == "create" }.flatMap { create in
            create.state == "failed" ? OrchestratorExplanation.text(for: create.errorCode ?? blockedReason ?? "create_failed") : nil
        }
        composerNote = Self.note(state: state, continuity: continuity, open: open, canMessage: canMessage,
                                 canResume: canResume, phase: phase, createFailure: createFailure)
    }

    /// Failed creates the server settles by recovery (it marks them as having forked nothing).
    static let recoverableCreateFailures: Set<String> = ["create_preallocation_failed", "create_authority_revoked"]

    public init(detail: OrchestratorDetail, agentWorking: Bool) {
        self.init(state: detail.orchestrator.state.rawValue, continuity: detail.orchestrator.continuity.rawValue,
                  blockedReason: detail.orchestrator.blockedReason, revision: detail.orchestrator.revision,
                  operations: detail.operations.map { ($0.kind.rawValue, $0.state.rawValue, $0.revision, $0.errorCode) },
                  agentWorking: agentWorking)
    }

    private static func note(state: String, continuity: String, open: OpenOperation?, canMessage: Bool,
                             canResume: Bool, phase: Phase, createFailure: String?) -> String? {
        if canMessage { return nil }
        if continuity == "lost" { return "The saved conversation was lost. Start a new orchestrator to continue." }
        if let open, open.uncertain {
            // Never a dead end (#847): say what the person can do while Armada settles it.
            return "Armada couldn't confirm the last \(open.kind) and is still checking; nothing is repeated meanwhile. "
                + "Come back later, or start a new orchestrator to keep working now."
        }
        if let open {
            return open.kind == "create" ? "Starting. You can write once it is ready."
                : "Waiting for the \(open.kind.replacingOccurrences(of: "_", with: " ")) to finish."
        }
        if let createFailure { return "Creation failed. " + createFailure }
        switch phase {
        case .creating: return "Starting. You can write once it is ready."
        case .stopping: return "Stopping…"
        case .stopped:
            return canResume ? "Stopped. Resume it to continue the same conversation."
                : "Stopped. Armada cannot resume a conversation it could not verify."
        case .resuming: return "Resuming the same conversation…"
        case .blocked(let explanation): return explanation
        case .unknown: return "This app does not know this orchestrator's state yet."
        case .ready: return nil
        }
    }
}

/// Where a create stands, read from the orchestrator's detail. Creation is asynchronous: the app
/// shows it as creating and polls detail until this settles; nothing is sent before `.ready`.
public enum OrchestratorCreateProgress: Sendable, Equatable {
    case creating
    case ready
    /// The create failed or the orchestrator is blocked: a plain sentence.
    case failed(String)

    public init(state: String, operations: [(kind: String, state: String, errorCode: String?)], blockedReason: String?) {
        let create = operations.last { $0.kind == "create" }
        if let create, create.state == "failed" {
            self = .failed(OrchestratorExplanation.text(for: create.errorCode ?? blockedReason ?? "create_failed"))
        } else if state == "blocked" {
            self = .failed(OrchestratorExplanation.text(for: blockedReason ?? "blocked"))
        } else if let create, create.state != "succeeded" {
            self = .creating
        } else if state == "creating" {
            self = .creating
        } else if state == "ready", create?.state == "succeeded" {
            self = .ready
        } else {
            self = .creating
        }
    }

    public init(detail: OrchestratorDetail) {
        self.init(state: detail.orchestrator.state.rawValue,
                  operations: detail.operations.map { ($0.kind.rawValue, $0.state.rawValue, $0.errorCode) },
                  blockedReason: detail.orchestrator.blockedReason)
    }
}

/// When to read an orchestrator's detail (or the list) again. Pure: the caller sleeps. Transitional
/// states and open operations are followed quickly; settled ones are not polled (the event stream
/// still follows the conversation); failed reads back off.
public enum OrchestratorPolling {
    public static let transitional = Duration.seconds(2)
    public static let settling = Duration.seconds(5)
    public static let maximumBackoff = Duration.seconds(60)

    /// nil: nothing is changing on its own, so no detail read is scheduled.
    public static func detailDelay(state: String, hasOpenOperation: Bool, consecutiveFailures: Int) -> Duration? {
        if consecutiveFailures > 0 { return backoff(consecutiveFailures) }
        if ["creating", "stopping", "resuming"].contains(state) { return transitional }
        if hasOpenOperation { return settling }
        return nil
    }

    /// The list refreshes while any orchestrator is in a transitional state.
    public static func listDelay(states: [String], consecutiveFailures: Int) -> Duration? {
        if consecutiveFailures > 0 { return backoff(consecutiveFailures) }
        return states.contains { ["creating", "stopping", "resuming"].contains($0) } ? settling : nil
    }

    /// 2 s, 4 s, 8 s … capped at a minute.
    public static func backoff(_ failures: Int) -> Duration {
        let exponent = min(max(failures, 1), 6)
        return min(.seconds(1 << exponent), maximumBackoff)
    }
}

/// Plain sentences for the server's closed codes: request errors (`error.code`), receipt
/// `errorCode`s, `blockedReason`s and disabled-pair reasons. An unknown code still gets a sentence,
/// with the code kept only as a reference after it.
public enum OrchestratorExplanation {
    /// A stable server code (`credential_refused`): lowercase words joined by underscores, bounded.
    static func isClosedCode(_ code: String) -> Bool {
        (1...64).contains(code.utf8.count) && code.utf8.allSatisfy { (97...122).contains($0) || $0 == 95 }
    }
    public static func text(for code: String) -> String {
        if let known = known[code] { return known }
        if code.hasPrefix("skillpack_") {
            return "Armada couldn't install the selected skill (\(code.replacingOccurrences(of: "_", with: " ")))."
        }
        let words = code.replacingOccurrences(of: "_", with: " ")
        return "Armada reported a problem it did not explain to this app version (\(words))."
    }

    static let known: [String: String] = [
        // Request errors.
        "conflict": "This orchestrator changed or is busy. The latest state is shown; check it and try again.",
        "not_found": "This orchestrator doesn't exist, or it isn't yours.",
        "unavailable": "Orchestrators are unavailable on this Armada server right now. Try again in a moment.",
        "invalid_request": "Armada refused this request as invalid. Reload and try again.",
        "credential_refused": "The model account was refused, revoked or expired. Replace or reconnect it, then try again.",
        "provider_unavailable": "The sandbox provider is temporarily unavailable. Try again later.",
        "dependency_unavailable": "An Armada server dependency is unavailable. Try again later.",
        "outcome_unknown": "Armada couldn't confirm whether this started. Check its status before retrying.",
        // Provider refusals (#919).
        "provider_payment_required": "The sandbox provider refused to start a machine because of the account's billing or credits. Settle it with the provider, then create a new orchestrator.",
        // Capabilities and pairs.
        "native_conformance_required": "Orchestrators are off on this server until each provider passes its native checks.",
        "server_setting_off": "This provider and agent pair isn't turned on for this server.",
        "production_runtime_unavailable": "This provider and agent pair isn't running on this server yet.",
        "native_resume_driver_unavailable": "This agent can't yet resume its native conversation on this provider.",
        "boat_native_checkpoint_restore_unavailable": "This provider can't yet restore an orchestrator's saved state.",
        "harness_catalog_missing": "This server doesn't list models for this agent yet.",
        // Receipts and blocked reasons.
        "runtime_uncertain": "Armada couldn't confirm what the runtime did. It is reconciling; nothing is repeated meanwhile.",
        "native_continuity_lost": "The saved conversation was lost. Start a new orchestrator to continue.",
        "boat_conversation_unavailable": "The provider couldn't open this orchestrator's conversation. Start a new orchestrator to continue.",
        "previous_conversation_not_continued": "It resumed with a new conversation; the previous one could not be continued.",
        "create_preallocation_failed": "Armada couldn't prepare the machine for this orchestrator. Create a new orchestrator to try again.",
        "create_authority_revoked": "Your access changed while it was being created. Create a new orchestrator to try again.",
        "create_worker_interrupted": "Creation was interrupted before it finished. Check its latest status before trying again.",
        "create_publication_fenced": "Creation was superseded by a newer change. Reload to see the latest state.",
        "create_recovery_unconfirmed": "Armada couldn't confirm the recovery yet. Retry recovery; it repeats the same request.",
        "create_aborted_before_fork": "Creation was stopped before any machine started.",
        "create_failed": "Armada couldn't create this orchestrator.",
        "wait_cap_exhausted": "It waited as long as it is allowed to, so Armada stopped admitting work to it.",
        "create_recovered_terminated": "Recovery stopped this orchestrator before it started. Create a new one to continue.",
        "stop_recovered_terminated": "Recovery confirmed the stop and released its machine.",
        "native_state_lost": "Its saved native state is gone, so it can't resume as the same conversation.",
        "owner_removed": "Its owner is no longer a member of this organization.",
        "hard_ttl": "It reached the longest time a machine may run, and was stopped.",
        "epoch_expiry": "Its machine session expired and was stopped.",
        "idle": "It stopped after being idle.",
        "blocked": "Armada stopped admitting work until this is resolved.",
        "stop_outcome_unconfirmed": "Armada couldn't confirm the stop. Recover it to settle the machine.",
        "native_stop_unconfirmed": "Armada couldn't confirm the stop. Recover it to settle the machine.",
        "child_outcome_unconfirmed": "Armada couldn't confirm a worker it started.",
        "child_dispatch_not_admitted": "A worker could not be started.",
    ]
}
