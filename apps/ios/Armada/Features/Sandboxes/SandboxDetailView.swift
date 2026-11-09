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
                        InlineBanner(text: "Only the owner or an organization admin can open this sandbox.", style: .info)
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

/// The read-only conversation of a sandbox the server lets this person open.
struct SandboxConversationView: View {
    let sandbox: SandboxSummary

    @Environment(AppModel.self) private var app
    @State private var feed = ConversationFeed()
    @State private var phase: Phase = .loading
    @State private var draft = ""

    private enum Phase: Equatable {
        case loading
        case loaded
        case refused(ServiceFailure)
    }

    var body: some View {
        Group {
            switch phase {
            case .loading:
                SurfaceStateView(state: .loading("Opening the conversation…"))
            case .refused(.unavailable(let reason)):
                SurfaceStateView(state: .unavailable(reason))
            case .refused(.noAccess):
                SurfaceStateView(state: .empty(
                    title: "No access",
                    message: "Armada did not open this sandbox for you. Only its owner or a current organization admin can.",
                    symbol: "lock"
                ))
            case .refused(let failure):
                SurfaceStateView(state: .failure(failure.message, retry: { Task { await open() } }))
            case .loaded:
                ConversationTranscript(
                    items: feed.conversation.items,
                    documents: feed.documents,
                    pending: [],
                    emptyTitle: "No messages",
                    emptyMessage: "This sandbox has no conversation yet."
                )
                .safeAreaInset(edge: .top, spacing: 0) {
                    if case .reconnecting = feed.connection {
                        InlineBanner(text: "Reconnecting…", style: .info)
                            .padding(.horizontal, 12)
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    ChatComposer(
                        draft: $draft,
                        placeholder: "Message",
                        unavailableReason: "Read-only in the app. Message this sandbox from the dashboard or CLI.",
                        isAgentWorking: feed.conversation.running,
                        agentName: sandbox.agentLabel,
                        steerRestartsTurn: sandbox.harness?.steerRestartsTurn ?? false,
                        sending: false,
                        onSend: { _, _ in }
                    )
                }
                .task {
                    let service = app.sandboxes
                    let id = sandbox.id
                    let orgID = sandbox.orgID
                    let fetch: ConversationFeed.Fetch = { (cursor: String?) async throws(ServiceFailure) -> OrchestratorEventPage in
                        let interior = try await service.interior(id: id, orgID: orgID, cursor: cursor)
                        return OrchestratorEventPage(events: interior.events, cursor: interior.cursor, hasMore: false)
                    }
                    await feed.follow(fetch) { app.sessionEnded() }
                    // A later refusal (access revoked, capability withdrawn) replaces the stale interior.
                    if case .stopped(let failure) = feed.connection { phase = .refused(failure) }
                }
            }
        }
        .background(ArmadaTheme.canvas)
        .navigationTitle(sandbox.displayLabel)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: sandbox.id) { await open() }
    }

    private func open() async {
        phase = .loading
        do throws(ServiceFailure) {
            let interior = try await app.sandboxes.interior(id: sandbox.id, orgID: sandbox.orgID, cursor: nil)
            await feed.seed(interior.events, cursor: interior.cursor)
            phase = .loaded
        } catch {
            if error == .signedOut {
                app.sessionEnded()
            } else {
                phase = .refused(error)
            }
        }
    }
}
