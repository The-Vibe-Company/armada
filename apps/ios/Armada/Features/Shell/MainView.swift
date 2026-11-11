import SwiftUI

/// The signed-in sandbox workspace.
struct MainView: View {
    var body: some View {
        SandboxListView()
        .tint(ArmadaTheme.textPrimary)
    }
}

/// The signed-in person's organization and session.
struct AccountView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingSignOut = false
    @State private var signingOut = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack(spacing: 14) {
                        ArmadaMarkTile(size: 52)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(app.organization?.name ?? "No organization")
                                .font(.headline)
                                .foregroundStyle(ArmadaTheme.textPrimary)
                            if let role = app.organization?.roleLabel {
                                Text(role)
                                    .font(.subheadline)
                                    .foregroundStyle(ArmadaTheme.textSecondary)
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)

                    if app.organizations.count > 1 {
                        SheetSection("Organization") {
                            Button {
                                dismiss()
                                app.chooseAnotherOrganization()
                            } label: {
                                SheetCard {
                                    SheetValueRow(title: "Switch Organization", symbol: "arrow.left.arrow.right", showsChevron: true)
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("account.switch-organization")
                        }
                    }

                    SheetSection(footer: "Signing out removes this device's Armada session from its secure storage.") {
                        Button(role: .destructive) {
                            confirmingSignOut = true
                        } label: {
                            HStack {
                                if signingOut { ProgressView().controlSize(.small) }
                                Text("Sign Out")
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.glass)
                        .controlSize(.large)
                        .disabled(signingOut)
                        .accessibilityIdentifier("account.sign-out")
                    }
                }
                .padding(20)
            }
            .background(ArmadaTheme.canvas)
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Sign out of Armada?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                Button("Sign Out", role: .destructive) {
                    signingOut = true
                    Task {
                        await app.signOut()
                        signingOut = false
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
