import SwiftUI

/// The persistent orchestrator conversation: native transcript, composer (message, or steer while
/// a turn runs), stop and resume, and a details sheet. The same conversation id survives stop and
/// resume; a lost conversation is never offered as resumable.
struct OrchestratorConversationView: View {
    let orchestratorID: String

    @Environment(AppModel.self) private var app
    @State private var model: OrchestratorConversationModel?
    @State private var showingDetails = false
    @State private var confirmingStop = false

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
                model = OrchestratorConversationModel(service: app.orchestrators, orchestratorID: orchestratorID) {
                    app.sessionEnded()
                }
            }
            await model?.load()
        }
    }

    @ViewBuilder
    private func screen(_ model: OrchestratorConversationModel) -> some View {
        switch model.phase {
        case .loading:
            SurfaceStateView(state: .loading("Loading conversation…"))
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
        case .loaded:
            conversation(model)
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
            onDismissPending: { model.dismiss($0) }
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
                    HeaderPill(summary: model.summary)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows the orchestrator's details")
                .accessibilityIdentifier("conversation.header")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Details", systemImage: "info.circle") { showingDetails = true }
                    if model.canResume {
                        Button("Resume", systemImage: "play.fill") { model.resume() }
                    }
                    if model.canStop {
                        Button("Stop", systemImage: "stop.fill", role: .destructive) { confirmingStop = true }
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
        .sheet(isPresented: $showingDetails) {
            if let detail = model.detail {
                OrchestratorDetailsSheet(detail: detail)
            }
        }
        .task(id: model.orchestratorID) {
            await model.follow()
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
