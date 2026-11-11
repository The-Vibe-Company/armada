#if DEBUG
import ArmadaKit
import Foundation

/// In-memory data for `#Preview` blocks only. It is compiled into Debug builds solely so Xcode
/// previews can render every state; no runtime path selects it (`AppModel.live()` wires
/// `ServiceWiring`). It is presentation evidence, not proof of a working backend.
enum PreviewData {
    static let me = "7c1d2e3f-0000-4000-8000-000000000001"
    static let teammate = "9a8b7c6d-0000-4000-8000-000000000002"
    static let orgID = "0f0e0d0c-0000-4000-8000-0000000000aa"

    static let organizations = [
        OrganizationChoice(id: orgID, name: "The Vibe Company", role: "admin"),
        OrganizationChoice(id: "0f0e0d0c-0000-4000-8000-0000000000bb", name: "Side Project", role: "member"),
    ]

    private static let now = Date()

    static let events: [AgentEvent] = [
        AgentEvent(id: "preview-prompt", at: now.addingTimeInterval(-60), conversationID: "preview", promptID: "pr_preview", body: .prompt(text: "Review the release notes.", status: .finished, reason: nil)),
        AgentEvent(id: "preview-message", at: now, conversationID: "preview", promptID: "pr_preview", body: .message(text: "The release notes are ready for review.", partial: false, messageID: "preview-message", textMode: .snapshot, model: nil, tools: [])),
    ]

    static let sandboxes: [SandboxSummary] = [
        sandbox("sbx-1a2b3c4d", owner: me, provider: .boat, providerID: "bx_9f2c41d7", status: .running, created: -860, canOpen: true),
        sandbox("sbx-5e6f7a8b", owner: teammate, provider: .modal, providerID: "sb-Qx81", status: .ready, created: -5_400, canOpen: true),
        sandbox("sbx-9c0d1e2f", owner: teammate, provider: .boat, providerID: nil, status: .stopped, created: -172_800, canOpen: false),
    ]

    private static func sandbox(
        _ id: String,
        owner: String,
        provider: ProviderID,
        providerID: String?,
        status: SandboxStatus,
        created: TimeInterval,
        canOpen: Bool
    ) -> SandboxSummary {
        SandboxSummary(
            id: id,
            orgID: orgID,
            ownerID: owner,
            provider: provider,
            providerSandboxID: providerID,
            harness: .claude,
            harnessRaw: "claude",
            model: "claude-opus-5-5",
            reasoningEffort: "medium",
            status: status,
            createdAt: now.addingTimeInterval(created),
            stoppedAt: status == .stopped ? now.addingTimeInterval(created + 3_600) : nil,
            expiresAt: status == .stopped ? nil : now.addingTimeInterval(10_800),
            effectiveTTLSeconds: 14_400,
            machineSize: "medium",
            displayLabel: "Sandbox \(id)",
            canOpen: canOpen,
            canManage: canOpen
        )
    }

    /// Static preview services. Mutations are acknowledged but change nothing.
    struct Services: SandboxService {
        var empty = false

        func list(orgID: String, page: Int) async throws(ServiceFailure) -> SandboxPage {
            SandboxPage(items: empty ? [] : PreviewData.sandboxes, total: empty ? 0 : PreviewData.sandboxes.count, nextPage: nil)
        }

        func sandboxState(id: String, orgID: String) async throws(ServiceFailure) -> SandboxState {
            guard let summary = PreviewData.sandboxes.first(where: { $0.id == id }), summary.canOpen else { throw .noAccess }
            let working = summary.status == .running
            return SandboxState(
                status: summary.status,
                statusReason: nil,
                turn: SandboxTurnState(promptID: "pr_preview", status: working ? .running : .finished, reason: nil),
                admission: working ? .turnRunning : .open,
                canStop: working || summary.status == .ready,
                isWorking: working
            )
        }

        func sandboxEvents(id: String, orgID: String, cursor: String?, backward: Bool) async throws(ServiceFailure) -> ConversationEventPage {
            guard PreviewData.sandboxes.contains(where: { $0.id == id && $0.canOpen }) else { throw .noAccess }
            return ConversationEventPage(
                events: cursor == nil ? PreviewData.events : [],
                cursor: "end",
                hasMore: false
            )
        }

        func sendPrompt(sandboxID: String, orgID: String, text: String) async throws(ServiceFailure) -> SandboxPromptAcceptance {
            // Shows the unconfirmed path in previews: an outcome is never invented as success.
            throw .uncertain
        }

        func stopSandbox(id: String, orgID: String) async throws(ServiceFailure) -> SandboxStatus {
            .stopping
        }
    }
}
#endif
