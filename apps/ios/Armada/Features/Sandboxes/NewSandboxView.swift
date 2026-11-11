import ArmadaKit
import Observation
import SwiftUI

/// The New sandbox form's state. ArmadaKit's pure catalog and draft decide what is offered and
/// what is sent (imported here for those values only); this model reads the options once, sends the
/// launch once, and keeps every field when Armada refuses.
@MainActor
@Observable
final class NewSandboxModel {
    enum Phase: Equatable {
        case loading
        case ready
        case unavailable(String)
        case failed(String)
    }

    /// The last launch's outcome when it did not open a sandbox.
    enum Outcome: Equatable {
        case problem(String)
        case refused(ArmadaKit.SandboxLaunchRefusal)
        case failedAfterStart(ArmadaKit.SandboxLaunchRefusal)
        case unconfirmed
        case notSent
    }

    private(set) var phase: Phase = .loading
    private(set) var catalog: ArmadaKit.SandboxLaunchCatalog?
    private(set) var launching = false
    private(set) var outcome: Outcome?
    private(set) var outcomeExplanation: String?
    private(set) var loadIssue: String?
    /// Set once a launch opened a sandbox: the list then starts a fresh form next time.
    private(set) var didLaunch = false
    var draft: ArmadaKit.SandboxLaunchDraft?
    var customModel = false

    /// nil when this build's services cannot launch: the form says so and sends nothing.
    @ObservationIgnored private let launcher: (any SandboxLauncher)?
    @ObservationIgnored let orgID: String
    @ObservationIgnored private let onSignedOut: @MainActor () -> Void

    init(launcher: (any SandboxLauncher)?, orgID: String, onSignedOut: @escaping @MainActor () -> Void) {
        self.launcher = launcher
        self.orgID = orgID
        self.onSignedOut = onSignedOut
    }

    func load() async {
        guard let launcher else {
            phase = .unavailable("Launching a sandbox isn't available in this build. Launch from the dashboard or the CLI.")
            return
        }
        if catalog == nil { phase = .loading }
        do throws(ServiceFailure) {
            let loaded = try await launcher.launchCatalog(orgID: orgID)
            catalog = loaded
            // A reload (after a golden was built elsewhere) keeps what the person already chose.
            if draft == nil { draft = ArmadaKit.SandboxLaunchDraft(catalog: loaded) }
            loadIssue = nil
            phase = .ready
        } catch {
            switch error.category {
            case .signedOut: onSignedOut()
            case .unavailable: phase = .unavailable(error.message)
            // A background reload keeps the form it already shows.
            default:
                if catalog == nil { phase = .failed(error.message) }
                else { loadIssue = error.message }
            }
        }
    }

    /// The only place a launch is sent. Returns the new sandbox, or nil with `outcome` explaining why.
    func launch() async -> SandboxSummary? {
        guard let launcher, let catalog, let draft, !launching else { return nil }
        outcomeExplanation = nil
        let request: ArmadaKit.SandboxLaunchRequest
        switch draft.request(catalog: catalog) {
        case .failure(let problem):
            outcome = .problem(problem.message)
            return nil
        case .success(let built):
            request = built
        }
        outcome = nil
        launching = true
        defer { launching = false }
        do throws(ArmadaKit.SandboxLaunchFailure) {
            let sandbox = try await launcher.launch(request)
            didLaunch = true
            return sandbox
        } catch {
            switch error {
            case .signedOut: onSignedOut()
            case .refused(let refusal): outcome = .refused(refusal)
            case .failedAfterStart(let refusal): outcome = .failedAfterStart(refusal)
            case .unconfirmedWithReason(let reason):
                outcome = .unconfirmed
                outcomeExplanation = reason
            case .notSentWithReason(let reason):
                outcome = .notSent
                outcomeExplanation = reason
            case .unconfirmed: outcome = .unconfirmed
            case .notSent: outcome = .notSent
            }
            return nil
        }
    }

    /// Leaving for the list closes the explanation; the fields stay for the next opening.
    func acknowledgeOutcome() { outcome = nil; outcomeExplanation = nil }
}

/// New sandbox, from the Sandboxes tab: a golden the person can launch (with its provider), the
/// agent, model and effort the server offers, the model account when there is a choice, optional
/// repository, machine size and lifetime, and the first prompt. Launch opens the new sandbox's
/// conversation; a refusal keeps every field and says why.
struct NewSandboxView: View {
    let model: NewSandboxModel
    let onLaunched: (SandboxSummary) -> Void
    let onShowList: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var showsMore = false
    @FocusState private var promptFocused: Bool

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .loading:
                    SurfaceStateView(state: .loading("Loading goldens and accounts…"))
                case .unavailable(let reason):
                    SurfaceStateView(state: .unavailable(reason))
                case .failed(let message):
                    SurfaceStateView(state: .failure(message, retry: { Task { await model.load() } }))
                case .ready:
                    if let catalog = model.catalog, model.draft != nil {
                        form(catalog)
                    }
                }
            }
            .background(ArmadaTheme.canvas)
            .navigationTitle("New Sandbox")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(model.launching)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.launching {
                        ProgressView()
                            .accessibilityLabel("Launching")
                    } else {
                        Button("Launch", action: launch)
                            .disabled(model.phase != .ready)
                            .accessibilityIdentifier("launch.submit")
                    }
                }
            }
        }
        .interactiveDismissDisabled(model.launching)
        // Every opening rereads goldens and accounts; the draft is kept.
        .task { await model.load() }
    }

    private func form(_ catalog: ArmadaKit.SandboxLaunchCatalog) -> some View {
        Form {
            if let issue = model.loadIssue { InlineBanner(text: issue, style: .error) }
            outcomeSection
            Group {
                goldenSection(catalog)
                agentSection(catalog)
                optionsSection(catalog)
                promptSection
            }
            .disabled(model.launching)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await model.load() }
    }

    // MARK: Sections

    @ViewBuilder
    private var outcomeSection: some View {
        if model.launching {
            Section {
                Label("Launching… Starting the machine and the agent can take a few minutes. Keep this screen open.", systemImage: "hourglass")
                    .font(.footnote)
                    .accessibilityIdentifier("launch.progress")
            }
        } else if let outcome = model.outcome {
            Section {
                if let explanation = model.outcomeExplanation {
                    InlineBanner(text: explanation, style: .error)
                }
                switch outcome {
                case .problem(let message):
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(ArmadaTheme.dangerText)
                case .refused(let refusal):
                    refusalText(refusal)
                case .failedAfterStart(let refusal):
                    refusalText(refusal)
                    Button("Show Sandboxes", action: onShowList)
                case .notSent:
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Armada can't be reached")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ArmadaTheme.dangerText)
                        Text("Nothing was launched. Check your connection, then launch again.")
                            .font(.footnote)
                            .foregroundStyle(ArmadaTheme.textSecondary)
                    }
                    .accessibilityElement(children: .combine)
                case .unconfirmed:
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Armada did not confirm this launch")
                            .font(.subheadline.weight(.semibold))
                        Text("A sandbox may have started. Check the Sandboxes list before launching again: launching again starts another sandbox.")
                            .font(.footnote)
                            .foregroundStyle(ArmadaTheme.textSecondary)
                        Button("Show Sandboxes", action: onShowList)
                            .buttonStyle(.glassProminent)
                    }
                }
            }
            .accessibilityIdentifier("launch.outcome")
        }
    }

    private func refusalText(_ refusal: ArmadaKit.SandboxLaunchRefusal) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(refusal.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ArmadaTheme.dangerText)
            Text(refusal.hint)
                .font(.footnote)
                .foregroundStyle(ArmadaTheme.textSecondary)
            if let detail = refusal.detail {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(ArmadaTheme.textPrimary)
                    .textSelection(.enabled)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func goldenSection(_ catalog: ArmadaKit.SandboxLaunchCatalog) -> some View {
        Section {
            if catalog.goldens.isEmpty {
                Text("No golden in this organization yet. Create one from the dashboard or the CLI.")
                    .font(.footnote)
                    .foregroundStyle(ArmadaTheme.textSecondary)
            } else {
                Picker("Golden", selection: goldenBinding(catalog)) {
                    ForEach(catalog.goldens) { golden in
                        Text(goldenLabel(golden, catalog: catalog))
                            .tag(Optional(golden.id))
                            .selectionDisabled(!golden.isReady)
                    }
                }
                .accessibilityIdentifier("launch.golden")
                if let golden = catalog.golden(model.draft?.goldenID) {
                    LabeledContent("Provider") {
                        ProviderBadge(provider: ProviderID(rawValue: golden.provider))
                    }
                }
            }
        } header: {
            Text("Golden")
        } footer: {
            Text("Organization goldens and your private ones. The golden decides where the sandbox runs.")
        }
    }

    @ViewBuilder
    private func agentSection(_ catalog: ArmadaKit.SandboxLaunchCatalog) -> some View {
        Section("Agent") {
            Picker("Agent", selection: harnessBinding(catalog)) {
                ForEach(catalog.harnesses) { harness in
                    Text(harnessLabel(harness.id)).tag(harness.id)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("launch.agent")
            modelFields(catalog)
            accountField(catalog)
        }
    }

    @ViewBuilder
    private func modelFields(_ catalog: ArmadaKit.SandboxLaunchCatalog) -> some View {
        let harness = catalog.harness(model.draft?.harness ?? "")
        if let harness, !model.customModel, !harness.models.isEmpty {
            Picker("Model", selection: modelBinding(catalog)) {
                ForEach(harness.models) { choice in
                    Text(choice.label).tag(choice.id)
                }
            }
            .accessibilityIdentifier("launch.model")
        } else {
            TextField("Model id", text: modelBinding(catalog))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.body.monospaced())
                .accessibilityIdentifier("launch.model-id")
        }
        if let harness, !harness.models.isEmpty {
            Toggle("Another model id", isOn: customModelBinding(catalog))
                .font(.footnote)
        }
        let efforts = harness?.efforts(for: model.draft?.model ?? "") ?? []
        if !efforts.isEmpty {
            Picker("Reasoning effort", selection: draftBinding(\.reasoningEffort, default: "")) {
                ForEach(efforts, id: \.self) { effort in
                    Text(effort.capitalized).tag(effort)
                }
            }
            .accessibilityIdentifier("launch.effort")
        }
    }

    @ViewBuilder
    private func accountField(_ catalog: ArmadaKit.SandboxLaunchCatalog) -> some View {
        let harness = model.draft?.harness ?? ""
        let accounts = catalog.accounts(for: harness)
        let now = Date()
        if catalog.offersAccountChoice(for: harness) {
            Picker("Model account", selection: draftBinding(\.accountID, default: nil)) {
                if catalog.defaultAccount(for: harness) == .ambiguous {
                    Text("Choose").tag(String?.none)
                }
                ForEach(accounts) { account in
                    Text(accountLabel(account, now: now))
                        .tag(Optional(account.id))
                        .selectionDisabled(account.problem(now: now) != nil)
                }
            }
            .accessibilityIdentifier("launch.account")
        } else if let account = accounts.first {
            LabeledContent("Model account", value: accountLabel(account, now: now))
        } else {
            Text("No \(harnessLabel(harness)) model account is available to you or the organization. Add one from the dashboard or the CLI.")
                .font(.footnote)
                .foregroundStyle(ArmadaTheme.textSecondary)
        }
    }

    @ViewBuilder
    private func optionsSection(_ catalog: ArmadaKit.SandboxLaunchCatalog) -> some View {
        let golden = catalog.golden(model.draft?.goldenID)
        Section {
            DisclosureGroup("More Options", isExpanded: $showsMore) {
                if let golden, catalog.offersRepositoryChoice(for: golden) {
                    Picker("Repository", selection: draftBinding(\.repository, default: nil)) {
                        Text("Golden default").tag(String?.none)
                        ForEach(catalog.repositories(of: golden), id: \.self) { directory in
                            Text(directory).tag(Optional(directory))
                        }
                    }
                    .accessibilityIdentifier("launch.repository")
                }
                if !catalog.machineSizes.isEmpty {
                    Picker("Machine size", selection: draftBinding(\.size, default: nil)) {
                        Text("Golden default").tag(String?.none)
                        ForEach(catalog.machineSizes, id: \.self) { size in
                            Text(MachineSizeLabel.label(for: size) ?? size).tag(Optional(size))
                        }
                    }
                    .accessibilityIdentifier("launch.size")
                }
                Picker("Stops after", selection: draftBinding(\.ttlSeconds, default: catalog.defaultTTLSeconds)) {
                    ForEach(catalog.ttlChoices(for: golden), id: \.self) { seconds in
                        Text(ttlLabel(seconds, isDefault: seconds == catalog.defaultTTLSeconds)).tag(seconds)
                    }
                }
                .accessibilityIdentifier("launch.ttl")
            }
        } footer: {
            Text("The machine stops by itself after its lifetime; its disk and conversation are kept and a new prompt resumes it.")
        }
    }

    private var promptSection: some View {
        Section {
            TextField("What should the agent do?", text: draftBinding(\.prompt, default: ""), axis: .vertical)
                .lineLimit(4...12)
                .focused($promptFocused)
                .accessibilityIdentifier("launch.prompt")
        } header: {
            Text("First prompt")
        } footer: {
            Text("The agent starts on it as soon as the sandbox is ready. You follow the turn in the conversation.")
        }
    }

    // MARK: Bindings and labels

    private func draftBinding<Value>(_ keyPath: WritableKeyPath<ArmadaKit.SandboxLaunchDraft, Value>, default fallback: Value) -> Binding<Value> {
        Binding(
            get: { model.draft?[keyPath: keyPath] ?? fallback },
            set: { value in model.draft?[keyPath: keyPath] = value }
        )
    }

    private func goldenBinding(_ catalog: ArmadaKit.SandboxLaunchCatalog) -> Binding<String?> {
        Binding(
            get: { model.draft?.goldenID },
            set: { id in if let id { model.draft?.adopt(goldenID: id, catalog: catalog) } }
        )
    }

    private func harnessBinding(_ catalog: ArmadaKit.SandboxLaunchCatalog) -> Binding<String> {
        Binding(
            get: { model.draft?.harness ?? "" },
            set: { harness in
                model.customModel = false
                model.draft?.adopt(harness: harness, catalog: catalog)
            }
        )
    }

    private func modelBinding(_ catalog: ArmadaKit.SandboxLaunchCatalog) -> Binding<String> {
        Binding(
            get: { model.draft?.model ?? "" },
            set: { value in model.draft?.adopt(model: value, catalog: catalog) }
        )
    }

    private func customModelBinding(_ catalog: ArmadaKit.SandboxLaunchCatalog) -> Binding<Bool> {
        Binding(
            get: { model.customModel },
            set: { custom in
                model.customModel = custom
                // Back to the list: the harness default again, never a free-typed id left selected.
                if !custom, let harness = model.draft?.harness { model.draft?.adopt(harness: harness, catalog: catalog) }
            }
        )
    }

    private func goldenLabel(_ golden: ArmadaKit.LaunchGolden, catalog: ArmadaKit.SandboxLaunchCatalog) -> String {
        var parts = [golden.name]
        if catalog.needsProviderLabel(golden) { parts.append(ProviderID(rawValue: golden.provider).label) }
        if golden.visibility == "private" { parts.append("private") }
        if !golden.isReady { parts.append("no snapshot") }
        return parts.joined(separator: " · ")
    }

    private func harnessLabel(_ id: String) -> String { Harness(rawValue: id)?.label ?? id }

    private func accountLabel(_ account: ArmadaKit.LaunchAccount, now: Date) -> String {
        var parts = [account.name, account.scope == .user ? "Personal" : "Organization"]
        if account.isDefault { parts.append("default") }
        if let problem = account.problem(now: now) { parts.append(problem) }
        return parts.joined(separator: " · ")
    }

    private func ttlLabel(_ seconds: Int, isDefault: Bool) -> String {
        let label: String = if seconds % 86_400 == 0 {
            seconds == 86_400 ? "1 day" : "\(seconds / 86_400) days"
        } else if seconds % 3_600 == 0 {
            seconds == 3_600 ? "1 hour" : "\(seconds / 3_600) hours"
        } else {
            "\(max(1, seconds / 60)) min"
        }
        return isDefault ? "\(label) (default)" : label
    }

    private func launch() {
        promptFocused = false
        Task {
            if let sandbox = await model.launch() { onLaunched(sandbox) }
        }
    }
}
