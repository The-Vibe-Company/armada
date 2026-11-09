import SwiftUI
import UIKit

/// Fail-closed link handling for agent-authored text, carried over from Companion `8e01b209`
/// (`CompanionLinkPolicy`, `CompanionMessageLinkDetector`) without Companion's app scheme.
enum LinkPolicy {
    static let allowedSchemes: Set<String> = ["http", "https", "mailto"]

    static func isAllowed(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), !scheme.isEmpty else { return false }
        return allowedSchemes.contains(scheme)
    }
}

struct DetectedLink: Equatable, Sendable {
    let url: URL
    let utf16Location: Int
    let utf16Length: Int
}

/// Finds bare, tappable URLs after Markdown parsing removed source-only punctuation. Callers
/// exclude code and already-linked runs.
enum MessageLinkDetector {
    static func detect(in text: String) -> [DetectedLink] {
        guard !text.isEmpty,
              let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        else { return [] }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return detector.matches(in: text, options: [], range: range).compactMap { result in
            guard let url = result.url, LinkPolicy.isAllowed(url) else { return nil }
            return DetectedLink(url: url, utf16Location: result.range.location, utf16Length: result.range.length)
        }
    }
}

@MainActor
enum MessageLinkActions {
    static func open(_ url: URL) {
        guard LinkPolicy.isAllowed(url) else { return }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }

    static func copy(_ url: URL) {
        UIPasteboard.general.url = url
        MessageInteractionFeedback.announce("Link copied")
    }
}

/// Presentation-only accessibility feedback. Haptics belong to `sensoryFeedback` at each action.
@MainActor
enum MessageInteractionFeedback {
    static func announce(_ message: String) {
        UIAccessibility.post(notification: .announcement, argument: message)
    }
}

private enum MessageInteractionSheet: Identifiable {
    case share(String)
    case selectText(String)

    var id: String {
        switch self {
        case .share: "share"
        case .selectText: "select-text"
        }
    }
}

/// Copy, Share and Select Text on long press, leaving inline selection in place. The selectable
/// sheet is deliberately raw text: a reliable native selection surface for rich Markdown.
private struct MessageInteractionModifier: ViewModifier {
    let rawContent: String

    @State private var presentedSheet: MessageInteractionSheet?
    @State private var copyFeedbackTrigger = 0

    func body(content: Content) -> some View {
        content
            .contentShape(.rect)
            .contextMenu {
                Button {
                    UIPasteboard.general.string = rawContent
                    copyFeedbackTrigger &+= 1
                    MessageInteractionFeedback.announce("Message copied")
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                Button {
                    presentedSheet = .share(rawContent)
                } label: {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
                Button {
                    presentedSheet = .selectText(rawContent)
                } label: {
                    Label("Select Text", systemImage: "selection.pin.in.out")
                }
            }
            .sensoryFeedback(.success, trigger: copyFeedbackTrigger)
            .sheet(item: $presentedSheet) { sheet in
                switch sheet {
                case .share(let text):
                    ActivityView(activityItems: [text])
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                case .selectText(let text):
                    SelectableTextSheet(content: text)
                }
            }
    }
}

extension View {
    func messageInteractionMenu(rawContent: String) -> some View {
        modifier(MessageInteractionModifier(rawContent: rawContent))
    }
}

private struct ActivityView: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

private struct SelectableTextSheet: View {
    @Environment(\.dismiss) private var dismiss
    let content: String

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(content)
                    .font(.body)
                    .foregroundStyle(ArmadaTheme.textPrimary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
            }
            .background(ArmadaTheme.canvas)
            .navigationTitle("Select Text")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
