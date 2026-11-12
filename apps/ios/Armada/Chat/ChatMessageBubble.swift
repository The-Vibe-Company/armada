import SwiftUI

/// Bubble geometry carried over from Companion `8e01b209` (`CompanionChatBubbleLayout`): at most
/// 80% of the width, never wider than 680 points; consecutive assistant entries sit closer.
enum ChatBubbleLayout {
    static let maximumWidthFraction = 0.8
    static let absoluteMaximumWidth = 680.0
    static let consecutiveAssistantSpacing: CGFloat = 8
    static let standardSpacing: CGFloat = 16

    static func maximumWidth(in availableWidth: Double) -> Double {
        max(0, min(availableWidth * maximumWidthFraction, absoluteMaximumWidth))
    }
}

struct ChatMessageBubble: View {
    enum Kind: Equatable {
        case mine
        case assistant
    }

    let content: String
    let kind: Kind
    var caption: String?
    var footnote: String?
    var markdown: MarkdownDocument?
    var streaming = false

    var body: some View {
        ChatBubbleRowLayout(trailing: kind == .mine) {
            bubble
        }
        .messageInteractionMenu(rawContent: content)
        .accessibilityElement(children: kind == .assistant || markdown?.containsInteractiveLink == true ? .contain : .combine)
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let caption {
                Text(caption)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(secondaryTextColor)
            }
            if let markdown {
                MarkdownMessageView(
                    document: markdown,
                    foreground: primaryTextColor,
                    linkColor: linkColor,
                    allowsTextSelection: false
                )
            } else {
                Text(content)
                    .font(.body)
                    .foregroundStyle(primaryTextColor)
                    .lineSpacing(3)
            }
            if streaming || footnote != nil {
                HStack(spacing: 6) {
                    if streaming {
                        ProgressView()
                            .controlSize(.mini)
                            .accessibilityLabel("Writing")
                    }
                    if let footnote {
                        Text(footnote)
                    }
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(secondaryTextColor)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(
            kind == .mine ? ArmadaTheme.userBubble : ArmadaTheme.botBubble,
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
    }

    private var primaryTextColor: Color {
        kind == .mine ? ArmadaTheme.userBubbleText : ArmadaTheme.textPrimary
    }

    private var secondaryTextColor: Color {
        kind == .mine ? ArmadaTheme.userBubbleText.opacity(0.68) : ArmadaTheme.textSecondary
    }

    private var linkColor: Color {
        kind == .mine ? ArmadaTheme.userBubbleLink : ArmadaTheme.linkBlue
    }
}

/// Places one bubble leading or trailing at its natural width, capped by `ChatBubbleLayout`.
struct ChatBubbleRowLayout: Layout {
    let trailing: Bool

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let subview = subviews.first else { return .zero }
        let available = proposal.width.map(Double.init) ?? ChatBubbleLayout.absoluteMaximumWidth
        let maximum = CGFloat(ChatBubbleLayout.maximumWidth(in: available))
        let child = subview.sizeThatFits(.init(width: maximum, height: proposal.height))
        return CGSize(width: proposal.width ?? child.width, height: child.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let subview = subviews.first else { return }
        let maximum = CGFloat(ChatBubbleLayout.maximumWidth(in: Double(bounds.width)))
        let child = subview.sizeThatFits(.init(width: maximum, height: proposal.height))
        let x = trailing ? bounds.maxX - child.width : bounds.minX
        subview.place(
            at: CGPoint(x: x, y: bounds.minY),
            anchor: .topLeading,
            proposal: .init(width: child.width, height: child.height)
        )
    }
}

/// A capsule above the composer while the agent works, Companion's `CompanionThinkingStatus`.
struct AgentWorkingStatus: View {
    let agentName: String

    var body: some View {
        HStack(spacing: 6) {
            ProgressView()
                .controlSize(.mini)
                .accessibilityHidden(true)
            Text("\(agentName) is working")
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(ArmadaTheme.textSecondary)
        .padding(.horizontal, 10)
        .frame(minHeight: 32)
        .background(ArmadaTheme.chip, in: RoundedRectangle(cornerRadius: 16))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(agentName) is working")
        .accessibilityIdentifier("chat.working-status")
    }
}
