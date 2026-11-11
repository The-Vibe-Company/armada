import SwiftUI

/// Shown when the person belongs to several organizations and none is selected yet (a single
/// organization is selected automatically). The selection is validated by ArmadaKit against the
/// current membership list before it is kept.
struct OrganizationPickerView: View {
    @Environment(AppModel.self) private var model
    @State private var selecting: String?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ArmadaBackdrop {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        Text("Choose the organization whose sandboxes you want to see. You can switch later from Account.")
                            .font(.subheadline)
                            .foregroundStyle(ArmadaTheme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let error {
                            InlineBanner(text: error, style: .error)
                        }
                        if model.organizations.isEmpty {
                            SurfaceStateView(
                                state: .empty(
                                    title: "No organization",
                                    message: "Your account is not a member of an organization yet. Ask an admin to invite you, or create one from the dashboard.",
                                    symbol: "building.2"
                                ),
                                action: (title: "Check Again", run: { Task { await model.retry() } })
                            )
                        } else {
                            SheetCard {
                                ForEach(Array(model.organizations.enumerated()), id: \.element.id) { index, choice in
                                    if index > 0 { SheetSeparator() }
                                    Button {
                                        choose(choice)
                                    } label: {
                                        HStack(spacing: 12) {
                                            Image(systemName: "building.2")
                                                .foregroundStyle(ArmadaTheme.textSecondary)
                                                .frame(width: 24)
                                                .accessibilityHidden(true)
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(choice.name)
                                                    .font(.body.weight(.semibold))
                                                    .foregroundStyle(ArmadaTheme.textPrimary)
                                                Text(choice.roleLabel)
                                                    .font(.footnote)
                                                    .foregroundStyle(ArmadaTheme.textSecondary)
                                            }
                                            Spacer()
                                            if selecting == choice.id {
                                                ProgressView().controlSize(.small)
                                            } else if model.organization?.id == choice.id {
                                                Image(systemName: "checkmark")
                                                    .foregroundStyle(ArmadaTheme.actionBlue)
                                                    .accessibilityLabel("Current")
                                            }
                                        }
                                        .padding(.horizontal, 16)
                                        .frame(minHeight: 60)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(selecting != nil)
                                    .accessibilityIdentifier("organization.\(choice.id)")
                                }
                            }
                        }
                    }
                    .padding(20)
                }
            }
            .navigationTitle("Organization")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Sign Out") {
                        Task { await model.signOut() }
                    }
                }
            }
        }
    }

    private func choose(_ choice: OrganizationChoice) {
        selecting = choice.id
        error = nil
        Task {
            error = await model.select(choice)
            selecting = nil
        }
    }
}

#if DEBUG
#Preview("Organizations") {
    OrganizationPickerView()
        .environment(AppModel.preview(phase: .choosingOrganization))
}
#endif
