import SwiftUI

/// The persistent orchestrator conversation: native transcript, composer (message, or steer while
/// a turn runs), stop and resume, and a details sheet. The same conversation id survives stop and
/// resume; a lost conversation is never offered as resumable.
struct OrchestratorConversationView: View {
    let orchestratorID: String
    /// The list row, shown in the header until detail is read. Display only: never authorizes.
    var listed: OrchestratorSummary?

    @Environment(AppModel.self) private var app
    @State private var model: OrchestratorConversationModel?
    @State private var showingDetails = false
    @State private var confirmingStop = false
    @State private var confirmingResume = false
    @State private var confirmingRecover = false
    /// Recover chosen in Details: confirmed once the sheet has finished closing, so the two
    /// presentations never overlap.
    @State private var recoverAfterDetails = false
    @State private var confirmingDiscard = false
    @State private var discardBubbleID: String?

    var body: some View {
        Group {
            if let model {
                screen(model)
            } else {
                SurfaceStateView(state: .loading("Loading conversation…"))
            }
        }
        .background(ArmadaTheme.canvas)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(ArmadaTheme.canvas, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task(id: orchestratorID) {
            // Keep pending messages, stop/resume keys and the draft when the screen reappears.
            if model?.orchestratorID != orchestratorID {
                model = OrchestratorConversationModel(service: app.orchestrators, orchestratorID: orchestratorID, memory: app.conversations) {
                    app.sessionEnded()
                }
            }
            await model?.load()
        }
    }

    @ViewBuilder
    private func screen(_ model: OrchestratorConversationModel) -> some View {
        switch model.phase {
        case .loading, .loaded:
            // Shown at once: the conversation is read beside detail, never after it.
            conversation(model)
        case .unavailable(let reason):
            SurfaceStateView(state: .unavailable(reason))
        case .noAccess:
            SurfaceStateView(state: .empty(
                title: "Not available",
                message: "This orchestrator does not exist or is private to its owner.",
                symbol: "lock"
            ))
        case .failed(let message):
            SurfaceStateView(state: .failure(message, retry: { Task { await model.load() } }))
        }
    }

    private func conversation(_ model: OrchestratorConversationModel) -> some View {
        @Bindable var model = model
        return ConversationTranscript(
            items: model.feed.conversation.items,
            documents: model.feed.documents,
            pending: model.pending,
            emptyTitle: model.feed.hasLoaded ? "No messages yet" : "Loading conversation…",
            emptyMessage: model.feed.hasLoaded
                ? "Tell \(model.summary?.name ?? "the orchestrator") what to coordinate. It launches one dedicated worker per ticket."
                : "Reading the conversation from Armada.",
            onRetryPending: { model.retry($0) },
            onDismissPending: {
                discardBubbleID = $0.id
                confirmingDiscard = true
            },
            hasOlder: model.feed.hasOlder,
            olderPagesRead: model.feed.olderPagesRead,
            onLoadOlder: { Task { await model.loadOlder() } }
        )
        .safeAreaInset(edge: .top, spacing: 0) {
            banners(model)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ChatComposer(
                draft: $model.draft,
                placeholder: "Message \(model.summary?.name ?? "orchestrator")",
                unavailableReason: model.composerUnavailableReason,
                isAgentWorking: model.feed.conversation.running,
                agentName: model.summary?.agentLabel ?? "The agent",
                steerRestartsTurn: model.summary?.harness?.steerRestartsTurn ?? false,
                sending: model.pending.contains { $0.status == .sending },
                onSend: { text, intent in model.send(text, intent: intent) }
            )
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button {
                    showingDetails = true
                } label: {
                    HeaderPill(summary: model.summary ?? listed)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows the orchestrator's details")
                .accessibilityIdentifier("conversation.header")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Details", systemImage: "info.circle") { showingDetails = true }
                    if model.hasUnconfirmedCommand {
                        Button("Forget Local Tracking…", systemImage: "trash", role: .destructive) {
                            discardBubbleID = nil
                            confirmingDiscard = true
                        }
                        .disabled(model.isDiscardingCommand)
                        .accessibilityIdentifier("conversation.discardUnconfirmed")
                    }
                    if model.canResume {
                        Button("Resume…", systemImage: "play.fill") { confirmingResume = true }
                            .accessibilityIdentifier("conversation.resume")
                    }
                    if model.canRecover {
                        Button("Recover…", systemImage: "wrench.and.screwdriver") { confirmingRecover = true }
                            .accessibilityIdentifier("conversation.recover")
                    }
                    if model.canStop {
                        Button("Stop…", systemImage: "stop.fill", role: .destructive) { confirmingStop = true }
                            .accessibilityIdentifier("conversation.stop")
                    }
                } label: {
                    Label("Actions", systemImage: "ellipsis")
                }
                .accessibilityIdentifier("conversation.actions")
            }
        }
        .confirmationDialog(
            "Stop \(model.summary?.name ?? "this orchestrator")?",
            isPresented: $confirmingStop,
            titleVisibility: .visible
        ) {
            Button("Stop", role: .destructive) { model.stop() }
        } message: {
            Text(stopMessage(model))
        }
        .confirmationDialog(
            "Resume \(model.summary?.name ?? "this orchestrator")?",
            isPresented: $confirmingResume,
            titleVisibility: .visible
        ) {
            Button("Resume") { model.resume() }
        } message: {
            Text("Compute starts again and continues the same saved conversation. No message is sent.")
        }
        .confirmationDialog(
            "Recover \(model.summary?.name ?? "this orchestrator")?",
            isPresented: $confirmingRecover,
            titleVisibility: .visible
        ) {
            Button("Recover", role: .destructive) { model.recover() }
        } message: {
            Text("Armada settles what it could not confirm and stops this orchestrator without starting anything new. Its history stays readable; to continue, you may need a new orchestrator.")
        }
        .confirmationDialog("Forget this unconfirmed request?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Forget Local Tracking", role: .destructive) {
                let bubbleID = discardBubbleID
                Task { await model.discardUnconfirmed(bubbleID: bubbleID) }
            }
        } message: {
            Text("The action may already have happened. This only forgets local tracking; it does not cancel the request. Trying a new request may duplicate its effects. Message text will not be restored to the draft.")
        }
        .sheet(isPresented: $showingDetails, onDismiss: {
            if recoverAfterDetails {
                recoverAfterDetails = false
                confirmingRecover = true
            }
        }) {
            if let detail = model.detail {
                OrchestratorDetailsSheet(detail: detail, canRecover: model.canRecover) {
                    recoverAfterDetails = true
                    showingDetails = false
                }
            }
        }
        .task(id: model.orchestratorID) {
            await model.follow()
        }
        .task(id: model.pollKey) {
            await model.pollDetail()
        }
        .onChange(of: model.feed.conversation.items) { _, _ in
            Task { await model.streamChanged() }
        }
    }

    @ViewBuilder
    private func banners(_ model: OrchestratorConversationModel) -> some View {
        VStack(spacing: 8) {
            if case .reconnecting = model.feed.connection {
                InlineBanner(text: "Reconnecting… The conversation continues from where it stopped.", style: .info)
            }
            if let detail = model.detail {
                switch detail.createProgress {
                case .creating where model.lifecycle == nil:
                    InlineBanner(text: "Armada is creating this orchestrator. You can write once it is ready.", style: .info)
                case .failed(let reason) where model.lifecycle == nil:
                    InlineBanner(
                        text: reason,
                        style: .error,
                        actionTitle: model.canRecover ? "Recover…" : nil,
                        action: { confirmingRecover = true }
                    )
                default:
                    EmptyView()
                }
            }
            switch model.lifecycle {
            case .sending(let kind):
                InlineBanner(text: Self.sendingText(kind), style: .info)
            case .inProgress(let kind):
                InlineBanner(text: "Armada is still processing the \(kind.label.lowercased()). New actions wait until it finishes.", style: .info)
            case .unconfirmed(let kind):
                InlineBanner(
                    text: "\(kind.label) was not confirmed. Retrying sends the same request.",
                    style: .warning,
                    actionTitle: "Retry",
                    action: { model.retryLifecycle() }
                )
                .disabled(model.isDiscardingCommand)
                Button("Forget Local Tracking…", role: .destructive) {
                    discardBubbleID = nil
                    confirmingDiscard = true
                }
                .disabled(model.isDiscardingCommand)
                .accessibilityIdentifier("conversation.discardUnconfirmedLifecycle")
            case nil:
                EmptyView()
            }
            if let notice = model.notice {
                InlineBanner(text: notice.text, style: notice.isError ? .error : .warning)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .background(ArmadaTheme.canvas.opacity(0.001))
    }

    private static func sendingText(_ kind: OperationKind) -> String {
        switch kind {
        case .stop: "Stopping… Admission closes first, then the conversation is saved."
        case .resume: "Resuming the same conversation…"
        case .recover: "Recovering… Armada is settling what it could not confirm."
        default: "Sending the \(kind.label.lowercased()) again…"
        }
    }

    private func stopMessage(_ model: OrchestratorConversationModel) -> String {
        let children = model.detail?.childSandboxIDs.count ?? 0
        let base = "Compute stops after the conversation is saved. You can resume the same conversation later."
        guard children > 0 else { return base }
        let workers = children == 1 ? "1 worker it launched keeps" : "\(children) workers it launched keep"
        return "\(base) \(workers) running; stop them separately from Sandboxes."
    }
}

private struct HeaderPill: View {
    let summary: OrchestratorSummary?

    var body: some View {
        HStack(spacing: 6) {
            Text(summary?.name ?? "Orchestrator")
                .font(.headline)
                .foregroundStyle(ArmadaTheme.textPrimary)
                .lineLimit(1)
            if let summary {
                StatusDot(tone: summary.state.tone)
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 36)
        .background(ArmadaTheme.card, in: Capsule())
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([summary?.name, summary?.state.label].compactMap { $0 }.joined(separator: ", "))
    }
}

#if DEBUG
#Preview("Conversation") {
    NavigationStack {
        OrchestratorConversationView(orchestratorID: PreviewData.leadID)
    }
    .environment(AppModel.preview())
}

#Preview("Conversation stopped") {
    NavigationStack {
        OrchestratorConversationView(orchestratorID: PreviewData.stoppedID)
    }
    .environment(AppModel.preview())
}

#Preview("Conversation blocked, lost") {
    NavigationStack {
        OrchestratorConversationView(orchestratorID: PreviewData.lostID)
    }
    .environment(AppModel.preview())
}
#endif
