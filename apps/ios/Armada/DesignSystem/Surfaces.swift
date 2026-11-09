import SwiftUI

/// Surfaces carried over from Companion `8e01b209` (`GlassComponents.swift`, `SheetComponents.swift`):
/// a flat canvas, cards with hairline borders, and 18-point continuous radii.
struct ArmadaBackdrop<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ZStack {
            ArmadaTheme.canvas.ignoresSafeArea()
            content
        }
    }
}

extension View {
    /// A card surface with a hairline border; `interactive` tints fields slightly more.
    func armadaCard(radius: CGFloat = 18, tint: Color? = nil, interactive: Bool = false) -> some View {
        modifier(ArmadaCardModifier(radius: radius, tint: tint, interactive: interactive))
    }
}

private struct ArmadaCardModifier: ViewModifier {
    let radius: CGFloat
    let tint: Color?
    let interactive: Bool

    func body(content: Content) -> some View {
        content
            .background(
                tint?.opacity(interactive ? 0.10 : 0.06) ?? ArmadaTheme.card,
                in: RoundedRectangle(cornerRadius: radius, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(ArmadaTheme.separator, lineWidth: 0.5)
            }
    }
}

struct SheetCard<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .background(ArmadaTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct SheetSection<Content: View>: View {
    let title: String?
    let footer: String?
    let content: Content

    init(_ title: String? = nil, footer: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title)
                    .font(.footnote)
                    .foregroundStyle(ArmadaTheme.textSecondary)
                    .padding(.horizontal, 4)
                    .accessibilityAddTraits(.isHeader)
            }
            content
            if let footer {
                Text(footer)
                    .font(.footnote)
                    .foregroundStyle(ArmadaTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
            }
        }
    }
}

struct SheetSeparator: View {
    var leading: CGFloat = 16

    var body: some View {
        Rectangle()
            .fill(ArmadaTheme.separator)
            .frame(height: 0.5)
            .padding(.leading, leading)
    }
}

/// A label/value row. Values wrap rather than truncate an identifier the person may need.
struct SheetValueRow: View {
    let title: String
    var value: String?
    var symbol: String?
    var monospacedValue = false
    var showsChevron = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.body)
                    .frame(width: 24)
                    .foregroundStyle(ArmadaTheme.textSecondary)
                    .accessibilityHidden(true)
            }
            Text(title)
                .font(.body)
                .foregroundStyle(ArmadaTheme.textPrimary)
            Spacer(minLength: 8)
            if let value {
                Text(value)
                    .font(monospacedValue ? .callout.monospaced() : .body)
                    .foregroundStyle(ArmadaTheme.textSecondary)
                    .multilineTextAlignment(.trailing)
                    .textSelection(.enabled)
            }
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(ArmadaTheme.textSecondary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

extension View {
    /// The text-field treatment of the sign-in and create forms.
    func armadaField() -> some View {
        self
            .padding(.horizontal, 14)
            .frame(minHeight: 50)
            .armadaCard(radius: 14, interactive: true)
    }
}
