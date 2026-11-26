import Foundation
import Testing

private func makeSandbox(
    id: String, displayLabel: String, provider: ProviderID = .boat,
    providerSandboxID: String? = nil, harness: Harness? = .claude,
    harnessRaw: String = "claude", model: String? = nil
) -> SandboxSummary {
    SandboxSummary(
        id: id, orgID: "org-1", ownerID: "user-1", provider: provider,
        providerSandboxID: providerSandboxID, harness: harness, harnessRaw: harnessRaw,
        model: model, reasoningEffort: nil, status: .ready,
        createdAt: Date(timeIntervalSince1970: 1_762_646_400), stoppedAt: nil,
        expiresAt: nil, effectiveTTLSeconds: nil, machineSize: "medium",
        displayLabel: displayLabel, canOpen: true, canManage: true
    )
}

@Test func matchesSearchCoversLabelIDsHarnessModelProviderAndMultiTermQueries() {
    let boat = makeSandbox(id: "1a2b3c4d-0000-4000-8000-000000000001", displayLabel: "Sandbox 1a2b3c4d", provider: .boat, providerSandboxID: "bx_9f2c41d7", harness: .claude, harnessRaw: "claude", model: "claude-opus-5-5")
    let modal = makeSandbox(id: "5e6f7a8b-0000-4000-8000-000000000002", displayLabel: "Sandbox 5e6f7a8b", provider: .modal, providerSandboxID: nil, harness: .codex, harnessRaw: "codex", model: nil)
    let custom = makeSandbox(id: "9c0d1e2f-0000-4000-8000-000000000003", displayLabel: "Sandbox 9c0d1e2f", provider: .docker, providerSandboxID: "dkr-77aa", harness: nil, harnessRaw: "custom-runner", model: "gpt-5")

    #expect(boat.matchesSearch("") && modal.matchesSearch("   \t\n "))
    #expect(boat.matchesSearch("sandbox 1a2b") && boat.matchesSearch("1A2B3C4D") && boat.matchesSearch("bx_9f2c") && !modal.matchesSearch("bx_9f2c"))
    #expect(boat.matchesSearch("Claude Code") && boat.matchesSearch("claude") && modal.matchesSearch("CODEX") && custom.matchesSearch("custom-runner"))
    #expect(boat.matchesSearch("opus-5-5") && modal.matchesSearch("modal") && custom.matchesSearch("Docker"))
    #expect(boat.matchesSearch("claude boat bx_9f2c") && !boat.matchesSearch("claude modal"))
    #expect(custom.matchesSearch("docker gpt-5") && !modal.matchesSearch("codex opus"))
}
