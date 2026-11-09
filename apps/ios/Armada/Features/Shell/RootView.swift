import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch model.phase {
            case .restoring:
                BootstrapView(message: nil, retry: nil)
            case .misconfigured(let message):
                BootstrapView(message: message, retry: nil)
            case .unreachable(let message):
                BootstrapView(message: message) {
                    Task { await model.retry() }
                }
            case .signedOut:
                SignInView()
            case .choosingOrganization:
                OrganizationPickerView()
            case .ready:
                MainView()
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.phase)
        .task { await model.restore() }
    }
}

struct BootstrapView: View {
    let message: String?
    let retry: (() -> Void)?

    var body: some View {
        ArmadaBackdrop {
            VStack(spacing: 18) {
                ArmadaMarkTile(size: 66)
                VStack(spacing: 6) {
                    Text("Armada")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(ArmadaTheme.textPrimary)
                    Text(message ?? "Restoring your session…")
                        .font(.subheadline)
                        .foregroundStyle(ArmadaTheme.textSecondary)
                        .multilineTextAlignment(.center)
                }
                if message == nil {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Restoring session")
                } else if let retry {
                    Button("Try Again", action: retry)
                        .buttonStyle(.glassProminent)
                        .accessibilityIdentifier("bootstrap.retry")
                }
            }
            .padding(32)
            .armadaCard()
            .padding(24)
        }
    }
}

#Preview("Restoring") {
    BootstrapView(message: nil, retry: nil)
}

#Preview("Unreachable") {
    BootstrapView(message: "Armada is temporarily unavailable.") {}
}
