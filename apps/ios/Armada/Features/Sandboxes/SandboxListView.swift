import ArmadaKit
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
    private(set) var turns: [String: RecordedTurnState] = [:]
    private(set) var total = 0
    private(set) var refreshError: String?
    private(set) var loadingMore = false

    @ObservationIgnored private var nextPage: Int?
    @ObservationIgnored private var loadedPages = 1
    @ObservationIgnored let service: any SandboxService
    @ObservationIgnored let orgID: String
    @ObservationIgnored private let onSignedOut: @MainActor () -> Void

    init(service: any SandboxService, orgID: String, onSignedOut: @escaping @MainActor () -> Void) {
        self.service = service
        self.orgID = orgID
        self.onSignedOut = onSignedOut
    }

    var hasMore: Bool { nextPage != nil }
    var hasLiveActivity: Bool { items.contains { isWorking($0) || $0.status == .starting || $0.status == .stopping } }

    func isWorking(_ sandbox: SandboxSummary, now: Date = .now) -> Bool {
        RecordedTurnState.isWorking(status: sandbox.status.rawValue, turn: turns[sandbox.id], expiresAt: sandbox.expiresAt, now: now)
    }

    func group(for sandbox: SandboxSummary, now: Date = .now) -> ListStatusGroup {
        .sandbox(sandbox.status.rawValue, turn: turns[sandbox.id], expiresAt: sandbox.expiresAt, now: now)
    }

    func load(silent: Bool = false) async {
        if !silent && items.isEmpty { phase = .loading }
        async let pageResult = Self.fetchPage(service: service, orgID: orgID)
        async let turnsResult = Self.fetchTurns(service: service, orgID: orgID)
        let (pageOutcome, turnsOutcome) = await (pageResult, turnsResult)
        if case .success(let latest) = turnsOutcome { turns = latest }
        else if case .failure(let error) = turnsOutcome, error.category == .signedOut {
            if !Task.isCancelled { onSignedOut() }
            return
        }
        switch pageOutcome {
        case .success(let page):
            if !silent || loadedPages <= 1 {
                items = page.items; nextPage = page.nextPage; loadedPages = 1
            } else {
                let fresh = Dictionary(uniqueKeysWithValues: page.items.map { ($0.id, $0) })
                let existing = Set(items.map(\.id))
                items = page.items.filter { !existing.contains($0.id) } + items.map { fresh[$0.id] ?? $0 }
            }
            total = page.total; refreshError = nil; phase = .loaded
        case .failure(let error):
            if silent { if error.category == .signedOut, !Task.isCancelled { onSignedOut() } }
            else { handle(error) }
        }
    }

    /// Light polling while the list is on screen: faster when turns or transitions are active.
    func pollWhileVisible() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: hasLiveActivity ? .seconds(8) : .seconds(20))
            guard !Task.isCancelled else { return }
            if phase == .loaded { await load(silent: true) }
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
            loadedPages += 1
        } catch {
            handle(error)
        }
    }

    private nonisolated static func fetchPage(service: any SandboxService, orgID: String) async -> Result<SandboxPage, ServiceFailure> {
        do throws(ServiceFailure) { return .success(try await service.list(orgID: orgID, page: 1)) } catch { return .failure(error) }
    }

    private nonisolated static func fetchTurns(service: any SandboxService, orgID: String) async -> Result<[String: RecordedTurnState], ServiceFailure> {
        do throws(ServiceFailure) { return .success(try await service.listTurns(orgID: orgID)) } catch { return .failure(error) }
    }

    private func handle(_ error: ServiceFailure) {
        if Task.isCancelled { return }
        switch error.category {
        case .signedOut:
            onSignedOut()
        case .unavailable:
            phase = .unavailable(error.message)
        default:
            if items.isEmpty { phase = .failed(error.message) } else { refreshError = error.message }
        }
    }
}

/// Every sandbox of the selected organization, as allowlisted metadata, grouped by status and
/// newest first (`ListOrdering`). Members see the list;
/// only the owner or a current admin can open the interior, and the server decides each time.
struct SandboxListView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: SandboxListModel?
    @State private var showingAccount = false
    @State private var newSandbox: NewSandboxModel?
    @State private var showingNewSandbox = false
    @State private var launched: SandboxSummary?
    @State private var disclosure = StatusSectionDisclosure()
    @State private var isListVisible = false

    var body: some View {
        NavigationStack {
            ArmadaBackdrop {
                content
            }
            .onAppear { isListVisible = true }
            .onDisappear { isListVisible = false }
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
                if sandbox.canOpen {
                    SandboxConversationView(sandbox: sandbox, initiallyWorking: model?.isWorking(sandbox) ?? false)
                } else {
                    SandboxDetailView(sandbox: sandbox)
                }
            }
            // With sandbox metadata, open its conversation and follow the first turn.
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
                        onLaunched: { destination in
                            showingNewSandbox = false
                            if case .conversation(let sandbox) = destination { launched = sandbox }
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
                disclosure = StatusSectionDisclosure()
            }
            await model?.load()
        }
        .task(id: pollTaskID) {
            guard isListVisible, scenePhase == .active, let model else { return }
            if model.phase == .loaded {
                await model.load(silent: true)
            }
            await model.pollWhileVisible()
        }
    }

    private var pollTaskID: String {
        "\(app.organization?.id ?? ""):\(isListVisible):\(scenePhase == .active)"
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
                    message: "Sandboxes launched in this organization appear here.",
                    symbol: "shippingbox"
                ))
                .listRowBackground(Color.clear)
            } else {
                let sections = ListOrdering.sections(
                    model.items, group: { model.group(for: $0) }, createdAt: \.createdAt, id: \.id
                )
                let groups = sections.map(\.group)
                ForEach(sections, id: \.group) { section in
                    let collapsed = disclosure.isCollapsed(section.group, groups: groups)
                    Section {
                        if !collapsed {
                            ForEach(section.items) { sandbox in
                                NavigationLink(value: sandbox) {
                                    SandboxRow(sandbox: sandbox, currentUserID: app.currentUserID, isWorking: model.isWorking(sandbox))
                                }
                                .accessibilityIdentifier("sandboxes.row.\(sandbox.id)")
                            }
                        }
                    } header: {
                        StatusSectionHeader(
                            group: section.group,
                            count: section.items.count,
                            collapsed: Binding(
                                get: { collapsed },
                                set: { disclosure.set(section.group, collapsed: $0) }
                            )
                        )
                    }
                }
                Section {
                    if model.hasMore {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                        // Keyed by the row count: a page that lands only in a collapsed group adds nothing visible,
                        // so the row never leaves the screen and must ask again after each page.
                        .task(id: model.items.count) { await model.loadMore() }
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
    var isWorking = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            VStack(alignment: .leading, spacing: 5) {
                headerLayout {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(sandbox.displayLabel)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(ArmadaTheme.textPrimary)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                            .truncationMode(.middle)
                            .fixedSize(horizontal: false, vertical: true)
                        if !sandbox.canOpen {
                            Image(systemName: "lock")
                                .font(.caption)
                                .foregroundStyle(ArmadaTheme.textSecondary)
                                .accessibilityLabel("Owner or admin only")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 8) {
                        Text(RelativeTime.age(of: sandbox.createdAt, now: context.date))
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(ArmadaTheme.textSecondary)
                        if isWorking {
                            WorkingBadge()
                        } else {
                            StatusDot(tone: sandbox.status.tone)
                        }
                    }
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
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText(now: context.date))
        }
    }

    private var headerLayout: AnyLayout {
        if dynamicTypeSize.isAccessibilitySize {
            return AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
        }
        return AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
    }

    private var owner: String { SandboxOwner.label(sandbox.ownerID, currentUserID: currentUserID) }
    private var statusText: String { isWorking ? "Working" : sandbox.status.label }

    private var secondLine: String {
        var parts = [statusText, owner, sandbox.agentLabel]
        if let model = sandbox.model { parts.append(model) }
        return parts.joined(separator: " · ")
    }

    private func accessibilityText(now: Date) -> String {
        var parts = [sandbox.displayLabel, statusText, sandbox.provider.label, sandbox.agentLabel, owner]
        if let model = sandbox.model, !model.isEmpty { parts.append("Model \(model)") }
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
