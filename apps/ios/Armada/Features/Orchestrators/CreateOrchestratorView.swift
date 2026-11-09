import SwiftUI

/// Create an orchestrator: name, golden (which fixes the provider), agent, model and effort, and a
/// named model account, with sensible defaults. Repository and idle stop sit under More Options.
/// The request carries an idempotency key; an unconfirmed create locks the form and can only be
/// retried as the same request.
struct CreateOrchestratorView: View {
    let list: OrchestratorListModel
    let onCreated: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var options: CreateOptions?
    @State private var loadError: ServiceFailure?
    @State private var draft = OrchestratorDraft()
    @State private var problem: DraftProblem?
    @State private var showsMore = false
    @State private var customModel = false
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
        .task { await loadOptions() }
    }

    /// A pending create (sending or unconfirmed) owns the form until it resolves.
    private var isLocked: Bool {
        list.hasOpenCreate || list.createStatus == .sending
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
                        }
                    case .refused(let reason):
                        Text(reason)
                            .font(.footnote)
                            .foregroundStyle(ArmadaTheme.dangerText)
                    }
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
                    if options.goldens.isEmpty {
                        Text("No golden in this organization yet. Create one from the dashboard or the CLI.")
                            .font(.footnote)
                            .foregroundStyle(ArmadaTheme.textSecondary)
                    } else {
                        Picker("Golden", selection: $draft.goldenID) {
                            Text("Choose").tag(String?.none)
                            ForEach(options.goldens) { golden in
                                Text(golden.isReady ? "\(golden.name) · \(golden.provider.label)" : "\(golden.name) · no snapshot")
                                    .tag(Optional(golden.id))
                                    .selectionDisabled(!golden.isReady)
                            }
                        }
                        .accessibilityIdentifier("create.golden")
                        if let golden = selectedGolden(options) {
                            LabeledContent("Provider") {
                                ProviderBadge(provider: golden.provider)
                            }
                        }
                    }
                }

                Section("Agent") {
                    Picker("Agent", selection: harnessBinding(options)) {
                        ForEach(Harness.allCases) { harness in
                            Text(harness.label).tag(harness)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("create.agent")
                    modelFields(options)
                    accountField(options)
                }

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
                            ForEach(IdlePolicy.choices, id: \.self) { seconds in
                                Text(IdlePolicy.label(seconds)).tag(seconds)
                            }
                        }
                        .accessibilityIdentifier("create.idle")
                    }
                } footer: {
                    Text("Compute stops after this long without real activity (running turns, tools, reviews, CI and active workers count). The conversation stays and can resume. Default: \(IdlePolicy.label(IdlePolicy.defaultSeconds)).")
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
        .onChange(of: draft.goldenID) { _, _ in
            if let repository = draft.repository, selectedGolden(options)?.repositories.contains(repository) != true {
                draft.repository = nil
            }
        }
    }

    @ViewBuilder
    private func modelFields(_ options: CreateOptions) -> some View {
        let models = options.catalog[draft.harness]
        if let models, !customModel {
            Picker("Model", selection: $draft.model) {
                ForEach(models.models) { choice in
                    Text(choice.label).tag(choice.id)
                }
            }
            .accessibilityIdentifier("create.model")
        } else {
            TextField("Model id", text: $draft.model)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.body.monospaced())
        }
        if models != nil {
            Toggle("Another model id", isOn: $customModel)
                .font(.footnote)
        }
        let efforts = models?.efforts(for: draft.model) ?? []
        if !efforts.isEmpty {
            Picker("Reasoning effort", selection: $draft.reasoningEffort) {
                ForEach(efforts, id: \.self) { effort in
                    Text(effort.capitalized).tag(effort)
                }
            }
        }
    }

    @ViewBuilder
    private func accountField(_ options: CreateOptions) -> some View {
        let accounts = options.accounts.filter { $0.harness == draft.harness }
        if accounts.isEmpty {
            Text("No \(draft.harness.label) model account is available to you. Add one from the dashboard or the CLI.")
                .font(.footnote)
                .foregroundStyle(ArmadaTheme.textSecondary)
        } else {
            Picker("Model account", selection: $draft.accountID) {
                ForEach(accounts) { account in
                    VStack(alignment: .leading) {
                        Text(account.name)
                        Text(account.detail)
                    }
                    .tag(Optional(account.id))
                }
            }
            .accessibilityIdentifier("create.account")
        }
    }

    private func harnessBinding(_ options: CreateOptions) -> Binding<Harness> {
        Binding(
            get: { draft.harness },
            set: { harness in
                customModel = false
                draft.adopt(harness: harness, options: options)
            }
        )
    }

    private func selectedGolden(_ options: CreateOptions?) -> GoldenChoice? {
        guard let options, let id = draft.goldenID else { return nil }
        return options.goldens.first { $0.id == id }
    }

    private func loadOptions() async {
        loadError = nil
        do throws(ServiceFailure) {
            let loaded = try await list.service.createOptions(orgID: list.orgID)
            if options == nil {
                draft.goldenID = loaded.goldens.first(where: \.isReady)?.id
                draft.adopt(harness: draft.harness, options: loaded)
                nameFocused = true
            }
            options = loaded
        } catch {
            loadError = error
        }
    }

    private func submit() {
        guard let options, !isLocked else { return }
        switch draft.request(orgID: list.orgID, options: options) {
        case .failure(let failure):
            problem = failure
        case .success(let request):
            problem = nil
            // A refused request is final; the edited form is a new intent with a new key.
            list.clearRefusedCreate()
            Task {
                if let id = await list.create(request) { onCreated(id) }
            }
        }
    }
}
