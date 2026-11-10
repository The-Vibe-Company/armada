import ArmadaKit
import SwiftUI

/// Create an orchestrator: name, golden (which fixes the provider), agent, model and effort, and a
/// named model account, with the server's defaults. Only provider × agent pairs the server reports
/// as enabled can be chosen; a disabled one is listed with the server's reason. Models, efforts and
/// account kinds come from the server's catalog. Repository and idle stop sit under More Options.
/// The request carries an idempotency key; an unconfirmed create locks the form and can only be
/// retried as the same request or explicitly forgotten after a duplicate-effects warning.
struct CreateOrchestratorView: View {
    let list: OrchestratorListModel
    let onCreated: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var options: CreateOptions?
    @State private var loadError: ServiceFailure?
    @State private var draft = ArmadaKit.OrchestratorCreateCatalog.Draft()
    @State private var problem: ArmadaKit.OrchestratorCreateCatalog.Problem?
    @State private var showsMore = false
    @State private var customModel = false
    @State private var confirmingDiscard = false
    @FocusState private var nameFocused: Bool

    var body: some View {
        NavigationStack {
            Group {
                if let options {
                    form(options)
                } else if let loadError {
                    switch loadError {
                    case .unavailable(let reason):
                        SurfaceStateView(state: .unavailable(reason))
                    default:
                        SurfaceStateView(state: .failure(loadError.message, retry: { Task { await loadOptions() } }))
                    }
                } else {
                    SurfaceStateView(state: .loading("Loading goldens and accounts…"))
                }
            }
            .background(ArmadaTheme.canvas)
            .navigationTitle("New Orchestrator")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if list.createStatus == .sending {
                        ProgressView()
                    } else {
                        Button("Create", action: submit)
                            .disabled(options == nil || isLocked)
                            .accessibilityIdentifier("create.submit")
                    }
                }
            }
        }
        .interactiveDismissDisabled(list.createStatus == .sending)
        .confirmationDialog("Forget this unconfirmed request?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Forget Local Tracking", role: .destructive) {
                Task { await list.discardUnconfirmedCreate() }
            }
        } message: {
            Text("The action may already have happened. This only forgets local tracking; it does not cancel the request. Trying a new request may duplicate its effects.")
        }
        .task { await loadOptions() }
    }

    /// A pending create (sending or unconfirmed) owns the form until it resolves.
    private var isLocked: Bool {
        list.hasOpenCreate || list.createStatus == .sending || list.isDiscardingCreate
    }

    private func form(_ options: CreateOptions) -> some View {
        Form {
            if let status = list.createStatus {
                Section {
                    switch status {
                    case .sending, .inProgress:
                        Label("Creating…", systemImage: "hourglass")
                    case .unconfirmed, .notSent:
                        VStack(alignment: .leading, spacing: 10) {
                            Text(status == .unconfirmed
                                ? "Armada did not confirm this request. Retrying resends the same request, so it cannot start a second orchestrator."
                                : "This request is saved on this device but was not sent. Retrying sends exactly it.")
                                .font(.footnote)
                            Button("Retry the Same Request") {
                                Task {
                                    if let id = await list.retryCreate() { onCreated(id) }
                                }
                            }
                            .buttonStyle(.glassProminent)
                            if status == .unconfirmed {
                                Button("Forget Local Tracking…", role: .destructive) { confirmingDiscard = true }
                                    .accessibilityIdentifier("create.discardUnconfirmed")
                            }
                        }
                        .disabled(list.isDiscardingCreate)
                    case .refused(let reason):
                        Text(reason)
                            .font(.footnote)
                            .foregroundStyle(ArmadaTheme.dangerText)
                    }
                }
            }

            if let error = list.createRecoveryError {
                Section {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(ArmadaTheme.dangerText)
                }
            }

            // Only the inputs lock while a create is pending; its status and Retry above stay live.
            Group {
                Section {
                    TextField("Name", text: $draft.name)
                        .focused($nameFocused)
                        .submitLabel(.done)
                        .accessibilityIdentifier("create.name")
                } footer: {
                    Text("For example, the project or release it coordinates.")
                }

                Section("Golden") {
                    if catalog(options).goldens.isEmpty {
                        Text("No golden in this organization yet. Create one from the dashboard or the CLI.")
                            .font(.footnote)
                            .foregroundStyle(ArmadaTheme.textSecondary)
                    } else {
                        Picker("Golden", selection: goldenBinding(options)) {
                            Text("Choose").tag(String?.none)
                            ForEach(catalog(options).goldens) { golden in
                                Text(golden.isReady ? "\(golden.name) · \(ProviderID(rawValue: golden.provider.rawValue).label)" : "\(golden.name) · no snapshot")
                                    .tag(Optional(golden.id))
                                    .selectionDisabled(!golden.isReady)
                            }
                        }
                        .accessibilityIdentifier("create.golden")
                        if let golden = selectedGolden(options) {
                            LabeledContent("Provider") {
                                ProviderBadge(provider: ProviderID(rawValue: golden.provider.rawValue))
                            }
                        }
                    }
                }

                agentSection(options)

                Section {
                    DisclosureGroup("More Options", isExpanded: $showsMore) {
                        Picker("Repository", selection: $draft.repository) {
                            Text("None").tag(String?.none)
                            ForEach(selectedGolden(options)?.repositories ?? [], id: \.self) { repository in
                                Text(repository).tag(Optional(repository))
                            }
                        }
                        .disabled(selectedGolden(options)?.repositories.isEmpty ?? true)
                        Picker("Stop when idle for", selection: $draft.idleSeconds) {
                            Text("Default (\(IdlePolicy.label(IdlePolicy.defaultSeconds)))").tag(Int?.none)
                            ForEach(IdlePolicy.choices.filter { $0 != IdlePolicy.defaultSeconds }, id: \.self) { seconds in
                                Text(IdlePolicy.label(seconds)).tag(Optional(seconds))
                            }
                        }
                        .accessibilityIdentifier("create.idle")
                    }
                } footer: {
                    Text("Compute stops after this long without real activity (running turns, tools, reviews, CI and active workers count). The conversation stays and can resume.")
                }
            }
            .disabled(isLocked)

            if let problem {
                Section {
                    Text(problem.message)
                        .font(.footnote)
                        .foregroundStyle(ArmadaTheme.dangerText)
                        .accessibilityIdentifier("create.problem")
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func catalog(_ options: CreateOptions) -> ArmadaKit.OrchestratorCreateCatalog { options.catalog }

    @ViewBuilder
    private func agentSection(_ options: CreateOptions) -> some View {
        let offers = selectedGolden(options).map { catalog(options).offers(for: $0) } ?? []
        let enabled = offers.filter(\.enabled)
        let disabled = offers.filter { !$0.enabled }
        Section {
            if enabled.isEmpty {
                Text(selectedGolden(options) == nil
                    ? "Choose a golden to see the agents this server runs on its provider."
                    : "This server runs no agent on this golden's provider yet.")
                    .font(.footnote)
                    .foregroundStyle(ArmadaTheme.textSecondary)
            } else {
                Picker("Agent", selection: harnessBinding(options)) {
                    ForEach(enabled) { offer in
                        Text(HarnessName.label(offer.harness.rawValue)).tag(Optional(offer.harness))
                    }
                }
                .accessibilityIdentifier("create.agent")
                if let harness = draft.harness, enabled.contains(where: { $0.harness == harness }) {
                    modelFields(options, harness: harness)
                    accountField(options, harness: harness)
                }
            }
        } header: {
            Text("Agent")
        } footer: {
            if !disabled.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(disabled) { offer in
                        Text("\(HarnessName.label(offer.harness.rawValue)) isn't available: \(offer.explanation ?? "turned off on this server.")")
                    }
                }
                .accessibilityIdentifier("create.disabledPairs")
            }
        }
    }

    @ViewBuilder
    private func modelFields(_ options: CreateOptions, harness: ArmadaKit.ArmadaHarness) -> some View {
        let models = catalog(options).catalog(for: harness)
        if let models, !models.models.isEmpty, !customModel {
            Picker("Model", selection: $draft.model) {
                ForEach(models.models) { choice in
                    Text(choice.label).tag(choice.id)
                }
                if !models.models.contains(where: { $0.id == draft.model }), !draft.model.isEmpty {
                    Text(draft.model).tag(draft.model)
                }
            }
            .accessibilityIdentifier("create.model")
        } else {
            TextField("Model id", text: $draft.model)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.body.monospaced())
                .accessibilityIdentifier("create.modelID")
        }
        if let models, !models.models.isEmpty {
            Toggle("Another model id", isOn: customModelBinding(models))
                .font(.footnote)
        }
        let efforts = models?.efforts(for: draft.model) ?? []
        if !efforts.isEmpty {
            Picker("Reasoning effort", selection: $draft.reasoningEffort) {
                ForEach(efforts, id: \.self) { effort in
                    Text(effort.capitalized).tag(effort)
                }
                if !efforts.contains(draft.reasoningEffort) {
                    Text("Choose").tag(draft.reasoningEffort)
                }
            }
            .accessibilityIdentifier("create.effort")
        }
    }

    @ViewBuilder
    private func accountField(_ options: CreateOptions, harness: ArmadaKit.ArmadaHarness) -> some View {
        let accounts = catalog(options).accounts(for: harness)
        if accounts.isEmpty {
            Text("No \(HarnessName.label(harness.rawValue)) model account is available to you. Add one from the dashboard or the CLI.")
                .font(.footnote)
                .foregroundStyle(ArmadaTheme.textSecondary)
        } else {
            Picker("Model account", selection: $draft.accountId) {
                ForEach(accounts) { account in
                    VStack(alignment: .leading) {
                        Text(account.name)
                        Text(Self.accountDetail(account))
                    }
                    .tag(Optional(account.id))
                }
            }
            .accessibilityIdentifier("create.account")
        }
    }

    private static func accountDetail(_ account: ArmadaKit.ModelAccount) -> String {
        let scope = account.scope == .user ? "Personal" : "Organization"
        return account.isDefault ? "\(scope) · Default" : scope
    }

    private func goldenBinding(_ options: CreateOptions) -> Binding<String?> {
        Binding(
            get: { draft.goldenId },
            set: { id in
                customModel = false
                if let id, let golden = catalog(options).goldens.first(where: { $0.id == id }) {
                    catalog(options).adopt(golden: golden, into: &draft)
                } else {
                    draft.goldenId = id
                }
            }
        )
    }

    private func harnessBinding(_ options: CreateOptions) -> Binding<ArmadaKit.ArmadaHarness?> {
        Binding(
            get: { draft.harness },
            set: { harness in
                customModel = false
                if let harness { catalog(options).adopt(harness: harness, into: &draft) }
            }
        )
    }

    /// Back to the suggestions restores the harness's default model and effort.
    private func customModelBinding(_ models: ArmadaKit.OrchestratorCapabilities.HarnessCatalog) -> Binding<Bool> {
        Binding(
            get: { customModel },
            set: { custom in
                customModel = custom
                if !custom, !models.models.contains(where: { $0.id == draft.model }) {
                    draft.model = models.defaultModel
                    draft.reasoningEffort = models.defaultReasoningEffort
                }
            }
        )
    }

    private func selectedGolden(_ options: CreateOptions?) -> ArmadaKit.GoldenSummary? {
        guard let options, let id = draft.goldenId else { return nil }
        return options.catalog.goldens.first { $0.id == id }
    }

    private func loadOptions() async {
        loadError = nil
        do throws(ServiceFailure) {
            let loaded = try await list.service.createOptions(orgID: list.orgID)
            if options == nil {
                let name = draft.name
                draft = loaded.catalog.initialDraft()
                draft.name = name
                nameFocused = true
            }
            options = loaded
        } catch {
            loadError = error
        }
    }

    private func submit() {
        guard let options, !isLocked else { return }
        switch options.catalog.request(orgId: list.orgID, draft: draft) {
        case .failure(let failure):
            problem = failure
        case .success(let configuration):
            problem = nil
            // A refused request is final; the edited form is a new intent with a new key.
            list.clearRefusedCreate()
            Task {
                if let id = await list.create(OrchestratorCreateRequest(configuration: configuration)) { onCreated(id) }
            }
        }
    }
}
