import SwiftUI

/// The compact status dot of Companion's roster (`CompanionStatusDot`): an 8-point dot in a fixed
/// 14-point slot, with a restrained pulse while live work runs. Reduce Motion keeps it static.
struct StatusDot: View {
    static let dotSize: CGFloat = 8
    static let containerSize: CGFloat = 14
    private static let pulseDuration: TimeInterval = 1.4

    let tone: StatusTone

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Circle()
                .fill(ArmadaTheme.tone(tone))
                .frame(width: Self.dotSize, height: Self.dotSize)

            if tone == .live, !reduceMotion {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: false)) { context in
                    let phase = Self.phase(at: context.date)
                    Circle()
                        .stroke(ArmadaTheme.tone(tone).opacity(0.35), lineWidth: 1)
                        .frame(width: Self.dotSize, height: Self.dotSize)
                        .scaleEffect(1 + phase * 0.65)
                        .opacity(Double(0.7 * (1 - phase)))
                }
            }
        }
        .frame(width: Self.containerSize, height: Self.containerSize)
        .accessibilityHidden(true)
    }

    private static func phase(at date: Date) -> CGFloat {
        let remainder = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: pulseDuration)
        return CGFloat(remainder / pulseDuration)
    }
}

/// A status dot with its label, for headers and detail rows.
struct StatusLabel: View {
    let text: String
    let tone: StatusTone

    var body: some View {
        HStack(spacing: 4) {
            StatusDot(tone: tone)
            Text(text)
                .font(.footnote.weight(.medium))
                .foregroundStyle(ArmadaTheme.textPrimary.opacity(0.8))
                .lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Status: \(text)")
    }
}

/// The provider as persisted on its row: the provider's own mark, then its name. The mark is
/// decorative; the name always sits beside it.
struct ProviderBadge: View {
    let provider: ProviderID
    var showsName = true

    var body: some View {
        HStack(spacing: 5) {
            mark
            if showsName {
                Text(provider.label)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Provider: \(provider.label)")
    }

    @ViewBuilder
    private var mark: some View {
        switch provider {
        case .boat:
            Image("ProviderBoat")
                .resizable()
                .scaledToFit()
                .frame(width: 13, height: 13)
        case .modal:
            Image("ProviderModal")
                .resizable()
                .scaledToFit()
                .frame(width: 18, height: 11)
        case .other:
            Image(systemName: "shippingbox")
                .font(.caption)
        }
    }
}

/// Full-surface states shared by every list and conversation: loading, an explicit unavailable
/// capability, a failure with retry, or empty. Never a blank screen.
struct SurfaceStateView: View {
    enum Phase {
        case loading(String)
        case unavailable(String)
        case failure(String, retry: (() -> Void)?)
        case empty(title: String, message: String, symbol: String)
    }

    let state: Phase
    var action: (title: String, run: () -> Void)?

    var body: some View {
        switch state {
        case .loading(let text):
            VStack(spacing: 12) {
                ProgressView()
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(ArmadaTheme.textSecondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .combine)
        case .unavailable(let reason):
            ContentUnavailableView {
                Label("Not available yet", systemImage: "hourglass")
            } description: {
                Text(reason)
            }
            .accessibilityIdentifier("state.unavailable")
        case .failure(let message, let retry):
            ContentUnavailableView {
                Label("Something went wrong", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                if let retry {
                    Button("Try Again", action: retry)
                        .buttonStyle(.glassProminent)
                        .accessibilityIdentifier("state.retry")
                }
            }
        case .empty(let title, let message, let symbol):
            ContentUnavailableView {
                Label(title, systemImage: symbol)
            } description: {
                Text(message)
            } actions: {
                if let action {
                    Button(action.title, action: action.run)
                        .buttonStyle(.glassProminent)
                }
            }
        }
    }
}

/// A slim inline banner for transient conditions above content that stays visible (reconnecting,
/// a stale revision, an uncertain request).
struct InlineBanner: View {
    enum Style {
        case info
        case warning
        case error
    }

    let text: String
    var style: Style = .info
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(text)
                .font(.footnote)
                .foregroundStyle(ArmadaTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderless)
                    .frame(minHeight: 44)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .frame(minHeight: 44)
        .armadaCard(radius: 14, tint: tint)
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch style {
        case .info: "arrow.triangle.2.circlepath"
        case .warning: "exclamationmark.circle"
        case .error: "exclamationmark.triangle"
        }
    }

    private var tint: Color {
        switch style {
        case .info: ArmadaTheme.textSecondary
        case .warning: ArmadaTheme.warningText
        case .error: ArmadaTheme.dangerText
        }
    }
}
