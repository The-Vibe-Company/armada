import SwiftUI

/// Sandbox metadata every member may see, and its conversation for the owner or a current admin.
/// `canOpen` only decides whether the conversation is offered; the server reauthorizes the read
/// and its refusal is shown as such.
struct SandboxDetailView: View {
    let sandbox: SandboxSummary

    @Environment(AppModel.self) private var app

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if sandbox.canOpen {
                        NavigationLink {
                            SandboxConversationView(sandbox: sandbox)
                        } label: {
                            SheetCard {
                                SheetValueRow(title: "Conversation", symbol: "bubble.left.and.text.bubble.right", showsChevron: true)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("sandbox.open-conversation")
                    } else {
                        InlineBanner(text: "Members see a sandbox's details. Only its owner or a current organization admin can open its conversation.", style: .info)
                            .accessibilityIdentifier("sandbox.metadata-only")
                    }
                    SheetSection("Sandbox") {
                        SheetCard {
                            SheetValueRow(title: "Status", value: sandbox.status.label)
                            SheetSeparator()
                            SheetValueRow(title: "Owner", value: SandboxOwner.label(sandbox.ownerID, currentUserID: app.currentUserID))
                            SheetSeparator()
                            SheetValueRow(title: "Created", value: RelativeTime.age(of: sandbox.createdAt, now: context.date))
                            if let stoppedAt = sandbox.stoppedAt {
                                SheetSeparator()
                                SheetValueRow(title: "Stopped", value: RelativeTime.age(of: stoppedAt, now: context.date))
                            } else if let expiresAt = sandbox.expiresAt {
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
                                SheetValueRow(title: "Model", value: [model, sandbox.reasoningEffort].compactMap { $0 }.joined(separator: " · "))
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
                                SheetValueRow(title: "Provider id", value: providerID, monospacedValue: true)
                            }
                            SheetSeparator()
                            SheetValueRow(title: "Armada id", value: sandbox.id, monospacedValue: true)
                        }
                    }
                }
                .padding(20)
            }
        }
        .background(ArmadaTheme.canvas)
        .navigationTitle(sandbox.displayLabel)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A sandbox's conversation for its owner or a current admin: the transcript followed live while a
/// turn runs, pull to refresh, a prompt composer when the sandbox accepts one, and stop with
/// confirmation. The server authorizes every read and action; a refusal is explained, not guessed.
struct SandboxConversationView: View {
    let sandbox: SandboxSummary

    @Environment(AppModel.self) private var app
    @State private var model: SandboxConversationModel?
    @State private var confirmingStop = false

    var body: some View {
        Group {
            if let model {
                screen(model)
            } else {
                SurfaceStateView(state: .loading("Opening the conversation…"))
            }
        }
        .background(ArmadaTheme.canvas)
        .navigationTitle(sandbox.displayLabel)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: sandbox.id) {
            // Keep pending prompts and the draft when the screen reappears.
            if model?.sandboxID != sandbox.id {
                model = SandboxConversationModel(service: app.sandboxes, sandboxID: sandbox.id, orgID: sandbox.orgID) {
                    app.sessionEnded()
                }
            }
            if model?.phase != .loaded { await model?.open() }
        }
    }

    @ViewBuilder
    private func screen(_ model: SandboxConversationModel) -> some View {
        switch model.phase {
        case .loading:
            SurfaceStateView(state: .loading("Opening the conversation…"))
        case .unavailable(let reason):
            SurfaceStateView(state: .unavailable(reason))
        case .noAccess:
            SurfaceStateView(state: .empty(
                title: "No access",
                message: "Armada did not open this sandbox for you. Only its owner or a current organization admin can read its conversation; members see its details only.",
                symbol: "lock"
            ))
        case .failed(let message):
            SurfaceStateView(state: .failure(message, retry: { Task { await model.open() } }))
        case .loaded:
            conversation(model)
        }
    }

    private func conversation(_ model: SandboxConversationModel) -> some View {
        @Bindable var model = model
        return ConversationTranscript(
            items: model.feed.conversation.items,
            documents: model.feed.documents,
            pending: model.pending,
            emptyTitle: model.isDeleted ? "Conversation unavailable" : "No messages yet",
            emptyMessage: model.isDeleted
                ? "This sandbox was deleted, so its conversation can no longer be read."
                : "Prompts you send and the agent's replies appear here.",
            onRetryPending: nil,
            onDismissPending: { model.dismiss($0) }
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
                // The server's turn state decides; this composer only ever sends a new turn.
                isAgentWorking: model.state?.isWorking == true,
                agentName: sandbox.agentLabel,
                steerRestartsTurn: sandbox.harness?.steerRestartsTurn ?? false,
                sending: model.pending.contains { $0.status == .sending },
                onSend: { text, _ in model.send(text) }
            )
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                SandboxHeader(title: sandbox.displayLabel, state: model.state)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
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
        .confirmationDialog("Stop \(sandbox.displayLabel)?", isPresented: $confirmingStop, titleVisibility: .visible) {
            Button("Stop", role: .destructive) { model.stop() }
        } message: {
            Text(model.isWorking
                ? "The running turn ends. The machine stops; its disk and conversation are kept, and the next prompt resumes it."
                : "The machine stops; its disk and conversation are kept, and the next prompt resumes it.")
        }
        // Restarts when a refresh revives a stopped follow, and ends once the sandbox is deleted.
        .task(id: "\(model.sandboxID):\(model.followGeneration):\(model.isDeleted)") { await model.follow() }
        .task(id: model.sandboxID) { await model.watchState() }
        .onChange(of: model.feed.conversation.items) { _, _ in model.streamChanged() }
    }

    @ViewBuilder
    private func banners(_ model: SandboxConversationModel) -> some View {
        VStack(spacing: 8) {
            if case .reconnecting = model.feed.connection {
                InlineBanner(text: "Reconnecting… The conversation continues from where it stopped.", style: .info)
            }
            if case .stopped = model.feed.connection, !model.isDeleted {
                InlineBanner(text: "Live updates paused. Pull to refresh to resume.", style: .warning)
            }
            if model.stopping {
                InlineBanner(text: "Stopping… The disk and conversation are kept.", style: .info)
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
    let title: String
    let state: SandboxState?

    var body: some View {
        HStack(spacing: 6) {
            Text(title)
                .font(.headline)
                .foregroundStyle(ArmadaTheme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
            if let state {
                StatusDot(tone: state.isWorking ? .live : state.status.tone)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([title, label].compactMap { $0 }.joined(separator: ", "))
        .accessibilityIdentifier("sandbox.conversation-header")
    }

    private var label: String? {
        guard let state else { return nil }
        return state.isWorking ? "Working" : state.status.label
    }
}

#if DEBUG
#Preview("Sandbox conversation") {
    NavigationStack {
        SandboxConversationView(sandbox: PreviewData.sandboxes.first { $0.canOpen }!)
    }
    .environment(AppModel.preview())
}
#endif
