import SwiftUI

struct OrchestratorRoute: Hashable {
    let id: String
}

/// The orchestrator-first home: the owner's persistent coordinators with their agent, provider,
/// state, last activity and idle stop.
struct OrchestratorListView: View {
    @Environment(AppModel.self) private var app
    @State private var model: OrchestratorListModel?
    @State private var path: [OrchestratorRoute] = []
    @State private var showingCreate = false
    @State private var showingAccount = false
    @State private var confirmingDiscard = false

    var body: some View {
        NavigationStack(path: $path) {
            ArmadaBackdrop {
                content
            }
            .navigationTitle("Orchestrators")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    AccountButton(showing: $showingAccount)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingCreate = true
                    } label: {
                        Label("New Orchestrator", systemImage: "plus")
                    }
                    .disabled(!canCreate)
                    .accessibilityIdentifier("orchestrators.create")
                }
            }
            .navigationDestination(for: OrchestratorRoute.self) { route in
                OrchestratorConversationView(orchestratorID: route.id)
            }
            .sheet(isPresented: $showingCreate) {
                if let model {
                    CreateOrchestratorView(list: model) { createdID in
                        showingCreate = false
                        path.append(OrchestratorRoute(id: createdID))
                    }
                }
            }
            .sheet(isPresented: $showingAccount) {
                AccountView()
            }
        }
        .confirmationDialog("Forget this unconfirmed request?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Forget Local Tracking", role: .destructive) {
                Task { await model?.discardUnconfirmedCreate() }
            }
        } message: {
            Text("The action may already have happened. This only forgets local tracking; it does not cancel the request. Trying a new request may duplicate its effects.")
        }
        .task(id: app.organization?.id) {
            guard let orgID = app.organization?.id else { return }
            // `.task` also restarts when the tab reappears: keep the model (and any unconfirmed
            // create with its key) unless the organization itself changed.
            if model?.orgID != orgID {
                model = OrchestratorListModel(service: app.orchestrators, orgID: orgID) { app.sessionEnded() }
                path = []
            }
            await model?.load()
        }
    }

    private var canCreate: Bool {
        guard let model else { return false }
        return model.phase == .loaded
    }

    @ViewBuilder
    private var content: some View {
        if let model {
            switch model.phase {
            case .loading:
                SurfaceStateView(state: .loading("Loading orchestrators…"))
            case .unavailable(let reason):
                SurfaceStateView(state: .unavailable(reason))
            case .failed(let message):
                SurfaceStateView(state: .failure(message, retry: { Task { await model.load() } }))
            case .loaded:
                loaded(model)
            }
        } else {
            SurfaceStateView(state: .loading("Loading orchestrators…"))
        }
    }

    @ViewBuilder
    private func loaded(_ model: OrchestratorListModel) -> some View {
        List {
            if let status = model.createStatus {
                Section {
                    PendingCreateRow(status: status, name: model.pendingCreateName ?? "An earlier orchestrator") {
                        Task {
                            if let id = await model.retryCreate() { path.append(OrchestratorRoute(id: id)) }
                        }
                    } dismiss: {
                        model.clearRefusedCreate()
                    } discard: {
                        confirmingDiscard = true
                    }
                    .disabled(model.isDiscardingCreate)
                }
            }
            if let error = model.createRecoveryError {
                Section {
                    InlineBanner(text: error, style: .error)
                }
            }
            if let refreshError = model.refreshError {
                Section {
                    InlineBanner(text: refreshError, style: .warning)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }
            if model.items.isEmpty {
                Section {
                    SurfaceStateView(
                        state: .empty(
                            title: "No orchestrators yet",
                            message: "An orchestrator is a long-lived coordinating conversation that launches one worker per ticket. Its compute stops when idle; the conversation stays.",
                            symbol: "point.3.connected.trianglepath.dotted"
                        ),
                        action: (title: "New Orchestrator", run: { showingCreate = true })
                    )
                    .listRowBackground(Color.clear)
                }
            } else {
                Section {
                    ForEach(model.items) { item in
                        NavigationLink(value: OrchestratorRoute(id: item.id)) {
                            OrchestratorRow(item: item)
                        }
                        .accessibilityIdentifier("orchestrators.row.\(item.id)")
                    }
                    if model.hasMore {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                        .task { await model.loadMore() }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable { await model.load() }
        .task(id: model.pollKey) { await model.pollWhileChanging() }
    }
}

struct OrchestratorRow: View {
    let item: OrchestratorSummary

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(ArmadaTheme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(RelativeTime.age(of: item.lastActivityAt, now: context.date))
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(ArmadaTheme.textSecondary)
                    StatusDot(tone: item.state.tone)
                }
                HStack(spacing: 6) {
                    Text("\(item.agentLabel) · \(item.model)")
                        .lineLimit(1)
                    Text("·")
                    ProviderBadge(provider: item.provider)
                }
                .font(.footnote)
                .foregroundStyle(ArmadaTheme.textSecondary)
                if let detail = detail(now: context.date) {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(item.state == .blocked ? ArmadaTheme.dangerText : ArmadaTheme.textSecondary)
                        .lineLimit(2)
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText(now: context.date))
        }
    }

    private func detail(now: Date) -> String? {
        switch item.state {
        case .blocked:
            return item.blockedExplanation ?? "Needs attention"
        case .ready:
            guard let deadline = item.idleDeadline else { return "Ready" }
            return "Ready · stops when idle \(RelativeTime.until(deadline, now: now))"
        default:
            return item.state.label
        }
    }

    private func accessibilityText(now: Date) -> String {
        var parts = [item.name, item.state.label, "\(item.agentLabel), \(item.model)", item.provider.label]
        parts.append("Last activity \(RelativeTime.age(of: item.lastActivityAt, now: now))")
        if let detail = detail(now: now), detail != item.state.label { parts.append(detail) }
        return parts.joined(separator: ", ")
    }
}

private struct PendingCreateRow: View {
    let status: OrchestratorListModel.CreateStatus
    let name: String
    let retry: () -> Void
    let dismiss: () -> Void
    let discard: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if status == .sending || status == .inProgress { ProgressView().controlSize(.small) }
                Text(title)
                    .font(.subheadline.weight(.semibold))
            }
            Text(message)
                .font(.footnote)
                .foregroundStyle(ArmadaTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            switch status {
            case .unconfirmed, .notSent:
                Button(action: retry) {
                    Text("Retry the Same Request").frame(minHeight: 44)
                }
                .buttonStyle(.glassProminent)
                if status == .unconfirmed {
                    Button("Forget Local Tracking…", role: .destructive, action: discard)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("orchestrators.discardUnconfirmedCreate")
                }
            case .refused:
                Button(action: dismiss) {
                    Text("Dismiss").frame(minHeight: 44)
                }
                .buttonStyle(.glass)
            case .sending, .inProgress:
                EmptyView()
            }
        }
        .padding(.vertical, 4)
    }

    private var title: String {
        switch status {
        case .sending, .inProgress: "Creating \(name)…"
        case .unconfirmed: "\(name) is not confirmed"
        case .notSent: "\(name) was not sent"
        case .refused: "\(name) was not created"
        }
    }

    private var message: String {
        switch status {
        case .sending:
            "Armada is recording the orchestrator before it starts its compute."
        case .inProgress:
            "Armada accepted this request and is still creating it. Another create waits until it finishes."
        case .unconfirmed:
            "Armada did not confirm this request. Retrying resends the same request, so it cannot start a second orchestrator."
        case .notSent(let reason):
            "\(reason) The request is saved on this device; retrying sends exactly it."
        case .refused(let reason):
            reason
        }
    }
}

struct AccountButton: View {
    @Binding var showing: Bool
    @Environment(AppModel.self) private var app

    var body: some View {
        Button {
            showing = true
        } label: {
            Label(app.organization?.name ?? "Account", systemImage: "person.crop.circle")
        }
        .accessibilityLabel("Account and organization")
        .accessibilityIdentifier("account.open")
    }
}

#if DEBUG
#Preview("Orchestrators") {
    MainView()
        .environment(AppModel.preview())
}

#Preview("Orchestrators unavailable") {
    MainView()
        .environment(AppModel.preview(orchestrators: UnavailableServices.orchestrators))
}

#Preview("Orchestrators empty") {
    MainView()
        .environment(AppModel.preview(orchestrators: PreviewData.Services(empty: true)))
}
#endif
