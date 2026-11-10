import Observation
import SwiftUI

@MainActor
@Observable
final class SandboxListModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case unavailable(String)
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var items: [SandboxSummary] = []
    private(set) var total = 0
    private(set) var refreshError: String?
    private(set) var loadingMore = false

    @ObservationIgnored private var nextPage: Int?
    @ObservationIgnored let service: any SandboxService
    @ObservationIgnored let orgID: String
    @ObservationIgnored private let onSignedOut: @MainActor () -> Void

    init(service: any SandboxService, orgID: String, onSignedOut: @escaping @MainActor () -> Void) {
        self.service = service
        self.orgID = orgID
        self.onSignedOut = onSignedOut
    }

    var hasMore: Bool { nextPage != nil }

    func load() async {
        if items.isEmpty { phase = .loading }
        do throws(ServiceFailure) {
            let page = try await service.list(orgID: orgID, page: 1)
            items = page.items
            total = page.total
            nextPage = page.nextPage
            refreshError = nil
            phase = .loaded
        } catch {
            handle(error)
        }
    }

    func loadMore() async {
        guard let nextPage, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do throws(ServiceFailure) {
            let page = try await service.list(orgID: orgID, page: nextPage)
            let known = Set(items.map(\.id))
            items.append(contentsOf: page.items.filter { !known.contains($0.id) })
            total = page.total
            self.nextPage = page.nextPage
        } catch {
            handle(error)
        }
    }

    private func handle(_ error: ServiceFailure) {
        if Task.isCancelled { return }
        switch error {
        case .signedOut:
            onSignedOut()
        case .unavailable(let reason):
            phase = .unavailable(reason)
        default:
            if items.isEmpty { phase = .failed(error.message) } else { refreshError = error.message }
        }
    }
}

/// Every sandbox of the selected organization, as allowlisted metadata. Members see the list;
/// only the owner or a current admin can open the interior, and the server decides each time.
struct SandboxListView: View {
    @Environment(AppModel.self) private var app
    @State private var model: SandboxListModel?
    @State private var showingAccount = false
    @State private var newSandbox: NewSandboxModel?
    @State private var showingNewSandbox = false
    @State private var launched: SandboxSummary?

    var body: some View {
        NavigationStack {
            ArmadaBackdrop {
                content
            }
            .navigationTitle("Sandboxes")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    AccountButton(showing: $showingAccount)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New Sandbox", systemImage: "plus", action: startNewSandbox)
                        .disabled(app.organization == nil)
                        .accessibilityIdentifier("sandboxes.new")
                }
            }
            .navigationDestination(for: SandboxSummary.self) { sandbox in
                SandboxDetailView(sandbox: sandbox)
            }
            // A launch lands directly in the new sandbox's conversation, following its first turn.
            .navigationDestination(item: $launched) { sandbox in
                SandboxConversationView(sandbox: sandbox)
            }
            .sheet(isPresented: $showingAccount) {
                AccountView()
            }
            .sheet(isPresented: $showingNewSandbox, onDismiss: {
                // After a launch the next form starts fresh; otherwise it keeps its fields.
                if newSandbox?.didLaunch == true { newSandbox = nil }
            }) {
                if let newSandbox {
                    NewSandboxView(
                        model: newSandbox,
                        onLaunched: { sandbox in
                            showingNewSandbox = false
                            launched = sandbox
                            Task { await model?.load() }
                        },
                        onShowList: {
                            newSandbox.acknowledgeOutcome()
                            showingNewSandbox = false
                            Task { await model?.load() }
                        }
                    )
                }
            }
        }
        .task(id: app.organization?.id) {
            guard let orgID = app.organization?.id else { return }
            // Rebuilt only when the organization changes; a reappearing tab just refreshes.
            if model?.orgID != orgID {
                model = SandboxListModel(service: app.sandboxes, orgID: orgID) { app.sessionEnded() }
            }
            await model?.load()
        }
    }

    /// Reuses the open form of this organization so a dismissed or refused launch keeps its fields.
    private func startNewSandbox() {
        guard let orgID = app.organization?.id else { return }
        if newSandbox?.orgID != orgID {
            newSandbox = NewSandboxModel(launcher: app.sandboxes as? any SandboxLauncher, orgID: orgID) { app.sessionEnded() }
        }
        showingNewSandbox = true
    }

    @ViewBuilder
    private var content: some View {
        if let model {
            switch model.phase {
            case .loading:
                SurfaceStateView(state: .loading("Loading sandboxes…"))
            case .unavailable(let reason):
                SurfaceStateView(state: .unavailable(reason))
            case .failed(let message):
                SurfaceStateView(state: .failure(message, retry: { Task { await model.load() } }))
            case .loaded:
                list(model)
            }
        } else {
            SurfaceStateView(state: .loading("Loading sandboxes…"))
        }
    }

    private func list(_ model: SandboxListModel) -> some View {
        List {
            if let refreshError = model.refreshError {
                InlineBanner(text: refreshError, style: .warning)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            if model.items.isEmpty {
                SurfaceStateView(state: .empty(
                    title: "No sandboxes",
                    message: "Sandboxes launched in this organization appear here, including the workers your orchestrators start.",
                    symbol: "shippingbox"
                ))
                .listRowBackground(Color.clear)
            } else {
                Section {
                    ForEach(model.items) { sandbox in
                        NavigationLink(value: sandbox) {
                            SandboxRow(sandbox: sandbox, currentUserID: app.currentUserID)
                        }
                        .accessibilityIdentifier("sandboxes.row.\(sandbox.id)")
                    }
                    if model.hasMore {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                        .task { await model.loadMore() }
                    }
                } footer: {
                    Text(model.total == 1 ? "1 sandbox" : "\(model.total) sandboxes")
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable { await model.load() }
    }
}

struct SandboxRow: View {
    let sandbox: SandboxSummary
    let currentUserID: String?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(sandbox.displayLabel)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(ArmadaTheme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if !sandbox.canOpen {
                        Image(systemName: "lock")
                            .font(.caption)
                            .foregroundStyle(ArmadaTheme.textSecondary)
                            .accessibilityLabel("Owner or admin only")
                    }
                    Spacer(minLength: 8)
                    Text(RelativeTime.age(of: sandbox.createdAt, now: context.date))
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(ArmadaTheme.textSecondary)
                    StatusDot(tone: sandbox.status.tone)
                }
                HStack(spacing: 6) {
                    ProviderBadge(provider: sandbox.provider)
                    if let providerID = sandbox.providerSandboxID {
                        Text(providerID)
                            .font(.footnote.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .font(.footnote)
                .foregroundStyle(ArmadaTheme.textSecondary)
                Text(secondLine)
                    .font(.footnote)
                    .foregroundStyle(ArmadaTheme.textSecondary)
                    .lineLimit(1)
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText(now: context.date))
        }
    }

    private var owner: String { SandboxOwner.label(sandbox.ownerID, currentUserID: currentUserID) }

    private var secondLine: String {
        var parts = [sandbox.status.label, owner, sandbox.agentLabel]
        if let model = sandbox.model { parts.append(model) }
        return parts.joined(separator: " · ")
    }

    private func accessibilityText(now: Date) -> String {
        var parts = [sandbox.displayLabel, sandbox.status.label, sandbox.provider.label, owner]
        parts.append("Created \(RelativeTime.age(of: sandbox.createdAt, now: now))")
        if !sandbox.canOpen { parts.append("Owner or admin only") }
        return parts.joined(separator: ", ")
    }
}

enum SandboxOwner {
    /// "You" when the server's owner id is the signed-in person, otherwise a short, stable owner
    /// reference. The list carries no member names, and none is looked up here.
    static func label(_ ownerID: String, currentUserID: String?) -> String {
        if let currentUserID, ownerID == currentUserID { return "You" }
        return "Member \(ownerID.prefix(8))"
    }
}

#if DEBUG
#Preview("Sandboxes") {
    SandboxListView()
        .environment(AppModel.preview())
}

#Preview("Sandboxes unavailable") {
    SandboxListView()
        .environment(AppModel.preview(sandboxes: UnavailableServices.sandboxes))
}
#endif
