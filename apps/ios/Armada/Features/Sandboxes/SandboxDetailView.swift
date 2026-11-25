import SwiftUI
import UIKit

/// Sandbox metadata every member may see, and shared inspector body for `SandboxInspectorSheet`.
struct SandboxDetailView: View {
    let sandbox: SandboxSummary
    var state: SandboxState?
    var isWorking: Bool?
    var title: String?

    @Environment(AppModel.self) private var app

    private var working: Bool { isWorking ?? (sandbox.status == .running) }
    private var expiresAt: Date? { state?.expiresAt ?? sandbox.expiresAt }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if !sandbox.canOpen {
                        InlineBanner(text: "Members see a sandbox's details. Only its owner or a current organization admin can open its conversation.", style: .info)
                            .accessibilityIdentifier("sandbox.metadata-only")
                    }
                    SheetSection("Sandbox") {
                        SheetCard {
                            if working {
                                HStack { Text("Status").font(.body).foregroundStyle(ArmadaTheme.textPrimary); Spacer(minLength: 8); WorkingBadge() }
                                    .padding(.horizontal, 16).frame(minHeight: 52).accessibilityElement(children: .combine)
                            } else {
                                SheetValueRow(title: "Status", value: (state?.status ?? sandbox.status).label)
                            }
                            SheetSeparator()
                            SheetValueRow(title: "Owner", value: SandboxOwner.label(sandbox.ownerID, currentUserID: app.currentUserID))
                            SheetSeparator()
                            SheetValueRow(title: "Created", value: RelativeTime.age(of: sandbox.createdAt, now: context.date))
                            if let stoppedAt = sandbox.stoppedAt {
                                SheetSeparator()
                                SheetValueRow(title: "Stopped", value: RelativeTime.age(of: stoppedAt, now: context.date))
                            } else if let expiresAt {
                                SheetSeparator()
                                SheetValueRow(title: "Stops", value: RelativeTime.until(expiresAt, now: context.date))
                            }
                            if let size = MachineSizeLabel.label(for: sandbox.machineSize) {
                                SheetSeparator()
                                SheetValueRow(title: "Machine", value: size)
                            }
                        }
                    }
                    SheetSection("Agent") {
                        SheetCard {
                            SheetValueRow(title: "Agent", value: sandbox.agentLabel)
                            if let model = sandbox.model {
                                SheetSeparator()
                                SheetValueRow(title: "Requested default", value: [model, sandbox.reasoningEffort].compactMap { $0 }.joined(separator: " · "))
                            }
                            if let turn = state?.turn {
                                SheetSeparator()
                                SheetValueRow(title: "Requested model", value: turn.requestedModel ?? "Unknown")
                                SheetSeparator()
                                SheetValueRow(title: "Observed model", value: turn.observedModel ?? "Unknown")
                                if let reason = turn.modelSelectionReason {
                                    SheetSeparator()
                                    SheetValueRow(title: reason == "model_selection_mismatch" ? "Model selection changed" : "Model not verified",
                                                  value: turn.modelSelectionMessage ?? "Model evidence is unavailable.")
                                }
                            }
                        }
                    }
                    SheetSection("Provider", footer: "The provider's id identifies the machine. It is not a credential and grants no access.") {
                        SheetCard {
                            HStack {
                                Text("Provider")
                                Spacer()
                                ProviderBadge(provider: sandbox.provider)
                                    .foregroundStyle(ArmadaTheme.textSecondary)
                            }
                            .padding(.horizontal, 16)
                            .frame(minHeight: 52)
                            if let providerID = sandbox.providerSandboxID {
                                SheetSeparator()
                                CopyableIDRow(title: "Provider id", value: providerID)
                            }
                            SheetSeparator()
                            CopyableIDRow(title: "Armada id", value: sandbox.id)
                        }
                    }
                }
                .padding(20)
            }
        }
        .background(ArmadaTheme.canvas)
        .navigationTitle(title ?? sandbox.displayLabel)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Inspector sheet presented from `SandboxConversationView` with live status, model evidence,
/// expiry, machine size, owner and copyable IDs.
struct SandboxInspectorSheet: View {
    let sandbox: SandboxSummary; let state: SandboxState?; let isWorking: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SandboxDetailView(sandbox: sandbox, state: state, isWorking: isWorking, title: "Details")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
}

private struct CopyableIDRow: View {
    let title: String; let value: String
    @State private var copied = false
    @State private var copyTrigger = 0

    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(.body).foregroundStyle(ArmadaTheme.textPrimary)
            Spacer(minLength: 8)
            Text(value).font(.callout.monospaced()).foregroundStyle(ArmadaTheme.textSecondary)
                .multilineTextAlignment(.trailing).textSelection(.enabled)
            Button {
                UIPasteboard.general.string = value; copied = true; copyTrigger &+= 1
                MessageInteractionFeedback.announce("\(title) copied")
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.footnote.weight(.semibold))
                    .foregroundStyle(copied ? ArmadaTheme.successText : ArmadaTheme.textSecondary)
                    .frame(minWidth: 36, minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel("Copy \(title)").sensoryFeedback(.success, trigger: copyTrigger)
        }
        .padding(.leading, 16).padding(.trailing, 8).padding(.vertical, 6).frame(minHeight: 52)
    }
}

/// A sandbox's conversation for its owner or a current admin: the transcript followed live while a
/// turn runs, pull to refresh, a prompt composer when the sandbox accepts one, and stop with
/// confirmation. The server authorizes every read and action; a refusal is explained, not guessed.
struct SandboxConversationView: View {
    let sandbox: SandboxSummary
    private let initiallyWorking: Bool

    @Environment(AppModel.self) private var app
    @State private var model: SandboxConversationModel
    @State private var confirmingStop = false
    @State private var showingDetails = false

    init(sandbox: SandboxSummary, app: AppModel, initiallyWorking: Bool = false) {
        self.sandbox = sandbox
        self.initiallyWorking = initiallyWorking
        _model = State(initialValue: Self.makeModel(sandbox: sandbox, app: app, initiallyWorking: initiallyWorking))
    }

    var body: some View {
        screen(model)
        .background(ArmadaTheme.canvas)
        .navigationTitle(sandbox.displayLabel)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: sandbox.id) {
            if model.sandboxID != sandbox.id { model = Self.makeModel(sandbox: sandbox, app: app, initiallyWorking: initiallyWorking) }
            await model.open()
        }
    }

    private static func makeModel(sandbox: SandboxSummary, app: AppModel, initiallyWorking: Bool) -> SandboxConversationModel {
        SandboxConversationModel(
            service: app.sandboxes, sandboxID: sandbox.id, orgID: sandbox.orgID,
            listedStatus: sandbox.status, listedWorking: initiallyWorking, memory: app.conversations
        ) { app.sessionEnded() }
    }

    @ViewBuilder
    private func screen(_ model: SandboxConversationModel) -> some View {
        switch model.phase {
        case .loading, .loaded:
            // Shown at once: the conversation is read beside the turn's state, never after it.
            conversation(model)
        case .unavailable(let reason):
            SurfaceStateView(state: .unavailable(reason))
        case .noAccess:
            SurfaceStateView(state: .empty(
                title: "No access",
                message: model.notice?.text ?? "Armada did not open this sandbox for you. Only its owner or a current organization admin can read its conversation; members see its details only.",
                symbol: "lock"
            ))
        case .failed(let message):
            SurfaceStateView(state: .failure(message, retry: { Task { await model.open() } }))
        }
    }

    private func conversation(_ model: SandboxConversationModel) -> some View {
        @Bindable var model = model
        return ConversationTranscript(
            items: model.feed.conversation.items,
            documents: model.feed.documents,
            pending: model.pending,
            emptyTitle: model.isDeleted ? "Conversation unavailable" : model.feed.hasLoaded ? "No messages yet" : "Loading conversation…",
            emptyMessage: model.isDeleted
                ? "This sandbox was deleted, so its conversation can no longer be read."
                : model.feed.hasLoaded ? "Prompts you send and the agent's replies appear here." : "Reading the latest messages from Armada.",
            onRetryPending: nil,
            onDismissPending: { model.dismiss($0) },
            hasOlder: model.feed.hasOlder,
            isLoadingOlder: model.feed.isLoadingOlder,
            olderPagesRead: model.feed.olderPagesRead,
            onLoadOlder: { Task { await model.loadOlder() } }
        )
        .refreshable { await model.refresh() }
        .safeAreaInset(edge: .top, spacing: 0) {
            banners(model)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ChatComposer(
                draft: $model.draft,
                placeholder: "Message \(sandbox.agentLabel)",
                unavailableReason: model.composerUnavailableReason,
                isAgentWorking: model.isWorking,
                agentName: sandbox.agentLabel,
                steerRestartsTurn: sandbox.harness?.steerRestartsTurn ?? false,
                sending: model.pending.contains { $0.status == .sending },
                interrupting: model.interrupting,
                onInterrupt: model.canInterrupt ? { model.interrupt() } : nil,
                onSend: { text, intent in model.send(text, intent: intent) }
            )
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button { showingDetails = true } label: {
                    SandboxHeader(title: sandbox.displayLabel, isWorking: model.isWorking, status: model.shownStatus)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows sandbox details")
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Details", systemImage: "info.circle") { showingDetails = true }
                    .accessibilityIdentifier("sandbox.details")
                Menu {
                    Button("Details", systemImage: "info.circle") { showingDetails = true }
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
                    if model.canInterrupt {
                        Button("Interrupt", systemImage: "hand.raised") { model.interrupt() }
                            .accessibilityIdentifier("sandbox.interrupt")
                    }
                    if model.canStop {
                        Button("Stop", systemImage: "stop.fill", role: .destructive) { confirmingStop = true }
                            .accessibilityIdentifier("sandbox.stop")
                    }
                } label: {
                    Label("Actions", systemImage: "ellipsis")
                }
                .accessibilityIdentifier("sandbox.actions")
            }
        }
        .sheet(isPresented: $showingDetails) {
            SandboxInspectorSheet(sandbox: sandbox, state: model.state, isWorking: model.isWorking)
        }
        .confirmationDialog("Stop \(sandbox.displayLabel)?", isPresented: $confirmingStop, titleVisibility: .visible) {
            Button("Stop", role: .destructive) { model.stop() }
        } message: {
            Text(model.isWorking
                ? "The running turn ends. The machine stops. Resuming later requires a retained disk and an unexpired sandbox."
                : "The machine stops. Resuming later requires a retained disk and an unexpired sandbox.")
        }
        // Restarts when a refresh revives a stopped follow, and ends once the sandbox is deleted.
        .task(id: "\(model.sandboxID):\(model.followGeneration):\(model.isDeleted)") { await model.follow() }
        .task(id: model.sandboxID) { await model.watchState() }
        .onChange(of: model.feed.conversation.items) { _, _ in model.streamChanged() }
    }

    @ViewBuilder
    private func banners(_ model: SandboxConversationModel) -> some View {
        VStack(spacing: 8) {
            if let turn = model.state?.turn {
                if let rateLimit = turn.rateLimit {
                    InlineBanner(text: rateLimit.summary, style: rateLimit.waiting ? .warning : .info)
                        .accessibilityIdentifier("sandbox.modelRateLimit")
                }
                if let reason = turn.modelSelectionReason {
                    let mismatch = reason == "model_selection_mismatch"
                    InlineBanner(text: "\(mismatch ? "Model selection changed" : "Model not verified"): \(turn.modelSelectionMessage ?? "Model evidence is unavailable.")", style: mismatch ? .warning : .info)
                }
            }
            if case .reconnecting(let reason) = model.feed.connection {
                InlineBanner(text: reason + " Reconnecting… The conversation continues from where it stopped.", style: .info)
            }
            if case .stopped = model.feed.connection, !model.isDeleted {
                InlineBanner(text: "Live updates paused. Pull to refresh to resume.", style: .warning)
            }
            if model.stopping {
                InlineBanner(text: "Stopping… Checking work preservation.", style: .info)
            }
            if let warning = model.state?.preservationWarning {
                InlineBanner(text: warning, style: .warning)
            }
            if let readIssue = model.readIssue {
                InlineBanner(text: readIssue, style: .warning)
            }
            if let notice = model.notice {
                InlineBanner(text: notice.text, style: notice.isError ? .error : .warning)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .background(ArmadaTheme.canvas.opacity(0.001))
    }
}

/// The sandbox name with its live state: working while a turn runs, otherwise the machine status.
private struct SandboxHeader: View {
    let title: String; let isWorking: Bool; let status: SandboxStatus?

    var body: some View {
        HStack(spacing: 6) {
            Text(title)
                .font(.headline)
                .foregroundStyle(ArmadaTheme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
            if isWorking { WorkingBadge() } else if let status { StatusDot(tone: status.tone) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([title, isWorking ? "Working" : status?.label].compactMap { $0 }.joined(separator: ", "))
        .accessibilityIdentifier("sandbox.conversation-header")
    }
}

#if DEBUG
#Preview("Sandbox conversation") {
    let app = AppModel.preview()
    NavigationStack {
        SandboxConversationView(sandbox: PreviewData.sandboxes.first { $0.canOpen }!, app: app)
    }
    .environment(app)
}
#endif
