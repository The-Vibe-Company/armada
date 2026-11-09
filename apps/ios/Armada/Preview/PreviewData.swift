#if DEBUG
import Foundation

/// In-memory data for `#Preview` blocks only. It is compiled into Debug builds solely so Xcode
/// previews can render every state; no runtime path selects it (`AppModel.live()` wires
/// `ServiceWiring`). It is presentation evidence, not proof of a working backend.
enum PreviewData {
    static let me = "7c1d2e3f-0000-4000-8000-000000000001"
    static let teammate = "9a8b7c6d-0000-4000-8000-000000000002"
    static let orgID = "0f0e0d0c-0000-4000-8000-0000000000aa"
    static let leadID = "orch-lead"
    static let stoppedID = "orch-stopped"
    static let lostID = "orch-lost"

    static let organizations = [
        OrganizationChoice(id: orgID, name: "The Vibe Company", role: "admin"),
        OrganizationChoice(id: "0f0e0d0c-0000-4000-8000-0000000000bb", name: "Side Project", role: "member"),
    ]

    private static let now = Date()

    static let orchestrators: [OrchestratorSummary] = [
        summary(id: leadID, name: "Release 3.0", harness: .claude, model: "claude-opus-5-5", effort: "high", provider: .boat, state: .ready, continuity: .native, lastActivity: -240, idleDeadline: 6_960),
        summary(id: stoppedID, name: "Docs cleanup", harness: .codex, model: "gpt-6.1-sol", effort: "medium", provider: .modal, state: .stopped, continuity: .native, lastActivity: -86_400 * 2, idleDeadline: nil),
        summary(id: lostID, name: "Billing migration", harness: .claude, model: "claude-sonnet-5-5", effort: nil, provider: .boat, state: .blocked, continuity: .lost, lastActivity: -7_200, idleDeadline: nil, blockedReason: "The saved conversation could not be found on resume."),
    ]

    private static func summary(
        id: String,
        name: String,
        harness: Harness,
        model: String,
        effort: String?,
        provider: ProviderID,
        state: OrchestratorState,
        continuity: OrchestratorContinuity,
        lastActivity: TimeInterval,
        idleDeadline: TimeInterval?,
        blockedReason: String? = nil
    ) -> OrchestratorSummary {
        OrchestratorSummary(
            id: id,
            ownerID: me,
            orgID: orgID,
            name: name,
            goldenID: "golden-main",
            provider: provider,
            harness: harness,
            harnessRaw: harness.rawValue,
            model: model,
            reasoningEffort: effort,
            modelAccountID: "account-\(harness.rawValue)",
            repository: "armada",
            idleSeconds: nil,
            maxActiveChildren: nil,
            state: state,
            revision: 7,
            sandboxID: state == .ready ? "sbx-lead" : nil,
            continuity: continuity,
            createdAt: now.addingTimeInterval(-86_400 * 5),
            updatedAt: now.addingTimeInterval(lastActivity),
            lastActivityAt: now.addingTimeInterval(lastActivity),
            idleDeadline: idleDeadline.map { now.addingTimeInterval($0) },
            blockedReason: blockedReason
        )
    }

    static func events(for id: String) -> [OrchestratorEvent] {
        guard id == leadID else {
            return [agent("s1", -90_000, .prompt(text: "Tidy the docs folder.", status: .finished, reason: nil), prompt: "p0"),
                    agent("s2", -89_000, .message(text: "Done: three files renamed, links updated.", partial: false, messageID: "m0", textMode: .snapshot, model: nil, tools: []), prompt: "p0"),
                    OrchestratorEvent(id: "s3", at: now.addingTimeInterval(-88_000), revision: 7, body: .state(.stopped, .native))]
        }
        let markdown = """
        Plan for **Release 3.0**:

        1. Open one ticket per change and launch a dedicated worker for each.
        2. Wait for CI, then review each PR.

        | Ticket | Worker | State |
        | --- | --- | --- |
        | #701 | sbx-1a2b | CI running |
        | #702 | sbx-3c4d | Review |

        ```bash
        armada launch --golden main --repo armada
        ```
        """
        return [
            agent("e1", -900, .prompt(text: "Coordinate the 3.0 release: one worker per ticket.", status: .finished, reason: nil), prompt: "p1"),
            agent("e2", -880, .message(text: markdown, partial: false, messageID: "m1", textMode: .snapshot, model: "claude-opus-5-5", tools: []), prompt: "p1"),
            agent("e3", -870, .message(text: "", partial: false, messageID: "m2", textMode: .snapshot, model: nil, tools: [
                ToolCall(id: "t1", name: "Bash", input: .object(["command": .string("gh issue list --label release-3.0")]), result: ToolResult(output: .string("#701 Upgrade SDK\n#702 Fix landing copy"), isError: false)),
            ]), prompt: "p1"),
            OrchestratorEvent(id: "e4", at: now.addingTimeInterval(-860), revision: 6, body: .child(sandboxID: "sbx-1a2b3c4d", operationID: "op-child")),
            OrchestratorEvent(id: "e5", at: now.addingTimeInterval(-850), revision: 6, body: .wait(
                WaitLease(id: "w1", kind: "ci", reference: "armada#701", reason: "CI for #701", expiresAt: now.addingTimeInterval(600), deadline: now.addingTimeInterval(80_000)),
                status: "active"
            )),
            agent("e6", -300, .prompt(text: "Prioritize #702 first.", status: .running, reason: nil), prompt: "p2"),
            agent("e7", -280, .steer(text: "Skip the landing copy; it ships next week.", mode: nil), prompt: "p2"),
            agent("e8", -240, .message(text: "Understood — re-planning without #702", partial: true, messageID: "m3", textMode: .delta, model: nil, tools: [
                ToolCall(id: "t2", name: "Read", input: .object(["file_path": .string("docs/releasing.md")]), result: nil),
            ]), prompt: "p2"),
        ]
    }

    private static func agent(_ id: String, _ offset: TimeInterval, _ body: AgentEvent.Body, prompt: String) -> OrchestratorEvent {
        let at = now.addingTimeInterval(offset)
        return OrchestratorEvent(
            id: id,
            at: at,
            revision: 7,
            body: .agent(AgentEvent(id: id, at: at, conversationID: "conv-1", promptID: prompt, body: body))
        )
    }

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

    static let createOptions = CreateOptions(
        goldens: [
            GoldenChoice(id: "golden-main", name: "main", provider: .boat, isReady: true, repositories: ["armada", "website"]),
            GoldenChoice(id: "golden-gpu", name: "gpu", provider: .modal, isReady: true, repositories: ["armada"]),
            GoldenChoice(id: "golden-new", name: "new-stack", provider: .boat, isReady: false, repositories: []),
        ],
        accounts: [
            ModelAccountChoice(id: "account-claude", name: "My Claude subscription", detail: "Personal", harness: .claude, isDefault: true),
            ModelAccountChoice(id: "account-claude-team", name: "Team Anthropic key", detail: "Organization", harness: .claude, isDefault: false),
            ModelAccountChoice(id: "account-codex", name: "My Codex login", detail: "Personal", harness: .codex, isDefault: true),
        ],
        catalog: [
            .claude: HarnessModels(
                defaultModel: "claude-opus-5-5",
                defaultReasoningEffort: "medium",
                reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
                models: [
                    ModelChoice(id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"]),
                    ModelChoice(id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"]),
                ]
            ),
            .codex: HarnessModels(
                defaultModel: "gpt-6.1-sol",
                defaultReasoningEffort: "medium",
                reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
                models: [
                    ModelChoice(id: "gpt-6.1-sol", label: "GPT-6.1 Sol", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"]),
                    ModelChoice(id: "gpt-6.1-terra", label: "GPT-6.1 Terra", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"]),
                ]
            ),
        ]
    )

    /// Static preview services. Mutations are acknowledged but change nothing.
    struct Services: OrchestratorService, SandboxService {
        var empty = false

        func list(orgID: String, cursor: String?) async throws(ServiceFailure) -> OrchestratorPage {
            OrchestratorPage(items: empty ? [] : PreviewData.orchestrators, cursor: nil)
        }

        func detail(id: String) async throws(ServiceFailure) -> OrchestratorDetail {
            guard let summary = PreviewData.orchestrators.first(where: { $0.id == id }) else { throw .noAccess }
            return OrchestratorDetail(
                summary: summary,
                operations: [],
                waits: id == PreviewData.leadID ? [
                    WaitLease(id: "w1", kind: "ci", reference: "armada#701", reason: "CI for #701", expiresAt: Date().addingTimeInterval(600), deadline: Date().addingTimeInterval(80_000)),
                ] : [],
                delegation: DelegationSummary(scopes: ["worker:launch", "worker:read", "worker:message", "worker:stop"], expiresAt: Date().addingTimeInterval(80_000), revokedAt: nil),
                childSandboxIDs: id == PreviewData.leadID ? ["sbx-1a2b3c4d"] : []
            )
        }

        func events(id: String, cursor: String?) async throws(ServiceFailure) -> OrchestratorEventPage {
            OrchestratorEventPage(events: cursor == nil ? PreviewData.events(for: id) : [], cursor: "end", hasMore: false)
        }

        func createOptions(orgID: String) async throws(ServiceFailure) -> CreateOptions {
            PreviewData.createOptions
        }

        func prepareCreate(_ request: OrchestratorCreateRequest) async throws(ServiceFailure) -> String {
            "create-\(UUID().uuidString)"
        }

        func prepareMutation(
            _ action: OrchestratorAction,
            orchestratorID: String,
            expectedRevision: Int
        ) async throws(ServiceFailure) -> String {
            "mutation-\(UUID().uuidString)"
        }

        func submit(handle: String) async throws(ServiceFailure) -> OperationSummary {
            guard handle.hasPrefix("create-") else {
                // Shows the unconfirmed path in previews: an outcome is never invented as success.
                throw .uncertain
            }
            return OperationSummary(id: handle, orchestratorID: PreviewData.leadID, kind: .create, state: .pending, revision: 1, errorCode: nil)
        }

        func unresolved(orgID: String, orchestratorID: String?) async -> UnresolvedOperation? { nil }

        func discard(handle: String) async {}

        func settle(handle: String) async {}

        func list(orgID: String, page: Int) async throws(ServiceFailure) -> SandboxPage {
            SandboxPage(items: empty ? [] : PreviewData.sandboxes, total: empty ? 0 : PreviewData.sandboxes.count, nextPage: nil)
        }

        func interior(id: String, orgID: String, cursor: String?) async throws(ServiceFailure) -> SandboxInterior {
            guard let summary = PreviewData.sandboxes.first(where: { $0.id == id }), summary.canOpen else { throw .noAccess }
            return SandboxInterior(
                summary: summary,
                events: cursor == nil ? Array(PreviewData.events(for: PreviewData.leadID).prefix(3)) : [],
                cursor: "end",
                acceptsMessages: false
            )
        }
    }
}
#endif
