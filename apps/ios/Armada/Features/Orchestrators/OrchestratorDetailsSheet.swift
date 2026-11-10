import ArmadaKit
import SwiftUI

/// Collapsed operational detail: configuration fixed at creation, continuity, open operations,
/// evidenced waits, launched workers and delegated-authority metadata. No token or credential is
/// ever part of this payload.
struct OrchestratorDetailsSheet: View {
    let detail: OrchestratorDetail
    /// Recovery is offered when the orchestrator can be recovered; the caller confirms first.
    var canRecover = false
    var onRecover: () -> Void = {}

    @Environment(\.dismiss) private var dismiss

    private var summary: OrchestratorSummary { detail.summary }

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        state(now: context.date)
                        configuration
                        if !detail.openOperations.isEmpty { operations }
                        if !detail.waits.isEmpty { waits(now: context.date) }
                        workers
                        if canRecover { recover }
                        if let delegation = detail.delegation { authority(delegation, now: context.date) }
                    }
                    .padding(20)
                }
            }
            .background(ArmadaTheme.canvas)
            .navigationDestination(for: ChildSandboxRoute.self) { route in
                ChildSandboxView(sandboxID: route.id)
            }
            .navigationTitle(summary.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func state(now: Date) -> some View {
        SheetSection("Status", footer: summary.continuity.explanation) {
            SheetCard {
                SheetValueRow(title: "State", value: summary.state.label)
                if let reason = summary.blockedExplanation, summary.state == .blocked {
                    SheetSeparator()
                    Text(reason)
                        .font(.footnote)
                        .foregroundStyle(ArmadaTheme.dangerText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                }
                SheetSeparator()
                SheetValueRow(title: "Conversation", value: summary.continuity.label)
                SheetSeparator()
                SheetValueRow(title: "Last activity", value: RelativeTime.age(of: summary.lastActivityAt, now: now))
                if let deadline = summary.idleDeadline {
                    SheetSeparator()
                    SheetValueRow(title: "Idle stop", value: RelativeTime.until(deadline, now: now))
                }
            }
        }
    }

    private var configuration: some View {
        SheetSection("Configuration", footer: "Fixed at creation. Armada never switches the agent, model, account or provider of a running conversation.") {
            SheetCard {
                SheetValueRow(title: "Agent", value: summary.agentLabel)
                SheetSeparator()
                SheetValueRow(title: "Model", value: summary.modelLine)
                SheetSeparator()
                HStack {
                    Text("Provider")
                    Spacer()
                    ProviderBadge(provider: summary.provider)
                        .foregroundStyle(ArmadaTheme.textSecondary)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 52)
                if let repository = summary.repository {
                    SheetSeparator()
                    SheetValueRow(title: "Repository", value: repository, monospacedValue: true)
                }
                SheetSeparator()
                SheetValueRow(
                    title: "Stops when idle for",
                    value: IdlePolicy.label(summary.idleSeconds ?? IdlePolicy.defaultSeconds)
                )
                if let limit = summary.maxActiveChildren {
                    SheetSeparator()
                    SheetValueRow(title: "Active workers at most", value: "\(limit)")
                }
            }
        }
    }

    private var operations: some View {
        SheetSection("In progress", footer: "An unconfirmed operation is reconciled by Armada under its original request; it is never repeated as a new one.") {
            SheetCard {
                ForEach(Array(detail.openOperations.enumerated()), id: \.element.id) { index, operation in
                    if index > 0 { SheetSeparator() }
                    SheetValueRow(
                        title: operation.kind.label,
                        value: operation.state == .uncertain ? "Not confirmed yet" : "Pending"
                    )
                    if let code = operation.errorCode {
                        Text(ArmadaKit.OrchestratorExplanation.text(for: code))
                            .font(.footnote)
                            .foregroundStyle(ArmadaTheme.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 10)
                    }
                }
            }
        }
    }

    private func waits(now: Date) -> some View {
        SheetSection("Waiting on", footer: "Evidenced waits keep the orchestrator active. Each renews only with fresh evidence and never past its deadline.") {
            SheetCard {
                ForEach(Array(detail.waits.enumerated()), id: \.element.id) { index, wait in
                    if index > 0 { SheetSeparator() }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(wait.kind.uppercased()) · \(wait.reason)")
                            .font(.body)
                            .foregroundStyle(ArmadaTheme.textPrimary)
                        Text("Expires \(RelativeTime.until(wait.expiresAt, now: now)) · deadline \(RelativeTime.until(wait.deadline, now: now))")
                            .font(.footnote)
                            .foregroundStyle(ArmadaTheme.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private var workers: some View {
        SheetSection("Workers", footer: "One dedicated worker sandbox per ticket. Workers keep running when the orchestrator stops.") {
            SheetCard {
                if detail.childSandboxIDs.isEmpty {
                    SheetValueRow(title: "Launched", value: "None yet")
                } else {
                    ForEach(Array(detail.childSandboxIDs.enumerated()), id: \.element) { index, sandboxID in
                        if index > 0 { SheetSeparator() }
                        NavigationLink(value: ChildSandboxRoute(id: sandboxID)) {
                            SheetValueRow(title: "Sandbox", value: sandboxID, monospacedValue: true, showsChevron: true)
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens this worker's sandbox")
                        .accessibilityIdentifier("details.worker.\(sandboxID)")
                    }
                }
            }
        }
    }

    private var recover: some View {
        SheetSection(footer: "Recovery settles what Armada could not confirm and stops this orchestrator without starting anything new.") {
            Button(action: onRecover) {
                Label("Recover…", systemImage: "wrench.and.screwdriver")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glass)
            .controlSize(.large)
            .accessibilityIdentifier("details.recover")
        }
    }

    private func authority(_ delegation: DelegationSummary, now: Date) -> some View {
        SheetSection("Delegated authority", footer: "Scoped to workers this orchestrator launched. The grant itself is never shown or sent to this app.") {
            SheetCard {
                SheetValueRow(title: "Scopes", value: delegation.scopes.joined(separator: ", "))
                SheetSeparator()
                if delegation.revokedAt != nil {
                    SheetValueRow(title: "Status", value: "Revoked")
                } else {
                    SheetValueRow(title: "Expires", value: RelativeTime.until(delegation.expiresAt, now: now))
                }
            }
        }
    }
}
