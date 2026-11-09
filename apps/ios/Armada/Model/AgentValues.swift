import Foundation

/// Presentation vocabulary shared by orchestrators and sandboxes. Raw values are the exact
/// strings of `@armada/core` (`HARNESSES`, `SandboxProviderId`, `PROMPT_STATUSES`,
/// `sandbox_status`, `MACHINE_SIZES`). A value this build does not know is preserved and shown
/// as-is rather than coerced into a known case.
enum Harness: String, CaseIterable, Identifiable, Hashable, Sendable {
    case claude
    case codex

    var id: String { rawValue }

    var label: String {
        switch self {
        case .claude: "Claude Code"
        case .codex: "Codex"
        }
    }

    /// Claude Code joins a running turn; Codex interrupts it and continues with the message
    /// (`STEER_RESTARTS_TURN` in the dashboard). Only the wording depends on it; the server decides.
    var steerRestartsTurn: Bool { self == .codex }
}

enum ProviderID: Hashable, Sendable {
    case boat
    case modal
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "boat": self = .boat
        case "modal": self = .modal
        default: self = .other(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .boat: "boat"
        case .modal: "modal"
        case .other(let value): value
        }
    }

    /// The same names as the dashboard's `PROVIDER_LABELS`.
    var label: String {
        switch self {
        case .boat: "Boat"
        case .modal: "Modal"
        case .other(let value): value
        }
    }
}

enum PromptStatus: Hashable, Sendable {
    case queued
    case running
    case finished
    case failed
    case interrupted
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "queued": self = .queued
        case "running": self = .running
        case "finished": self = .finished
        case "failed": self = .failed
        case "interrupted": self = .interrupted
        default: self = .other(rawValue)
        }
    }

    var isActive: Bool { self == .queued || self == .running }
}

enum SandboxStatus: Hashable, Sendable {
    case starting
    case ready
    case running
    case stopping
    case stopped
    case failed
    case deleted
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "starting": self = .starting
        case "ready": self = .ready
        case "running": self = .running
        case "stopping": self = .stopping
        case "stopped": self = .stopped
        case "failed": self = .failed
        case "deleted": self = .deleted
        default: self = .other(rawValue)
        }
    }

    var label: String {
        switch self {
        case .starting: "Starting"
        case .ready: "Ready"
        case .running: "Running"
        case .stopping: "Stopping"
        case .stopped: "Stopped"
        case .failed: "Failed"
        case .deleted: "Deleted"
        case .other(let value): value.capitalized
        }
    }

    var tone: StatusTone {
        switch self {
        case .running: .live
        case .ready: .ready
        case .starting, .stopping: .transitioning
        case .failed: .error
        case .stopped, .deleted, .other: .inactive
        }
    }
}

/// One visual vocabulary for every status dot, so orchestrators and sandboxes read the same.
enum StatusTone: Hashable, Sendable {
    /// Working now (a turn is running).
    case live
    /// Admitted compute, idle.
    case ready
    /// Starting, stopping, resuming or an operation in flight.
    case transitioning
    /// Needs attention.
    case error
    /// Stopped or unknown.
    case inactive
}

/// The effective machine size label of `MACHINE_SIZES`.
enum MachineSizeLabel {
    static func label(for raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        switch raw {
        case "small": return "Small"
        case "medium": return "Medium"
        case "large": return "Large"
        case "xlarge": return "Extra large"
        default: return raw
        }
    }
}
