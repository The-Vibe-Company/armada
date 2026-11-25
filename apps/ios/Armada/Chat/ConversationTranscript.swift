import SwiftUI
import UIKit
import ArmadaKit

/// A local message the person sent that the conversation does not show yet.
struct PendingBubble: Identifiable, Hashable {
    enum Status: Hashable {
        case sending
        /// Accepted by the server; waits for its event to appear in the conversation.
        case accepted
        /// Outcome unknown: check the conversation before sending again.
        case unconfirmed
    }

    let id: String
    let text: String
    /// What was asked; becomes `.message` when the turn had already ended (#847).
    var intent: ComposerIntent
    let sentAt: Date
    var status: Status
}

/// The conversation surface for sandboxes, with Companion's transcript
/// behavior: initial placement at the bottom, following the tail only while the reader is near it,
/// a jump-to-latest control otherwise, and interactive keyboard dismissal. The latest messages are
/// read first; reaching the top reads older history (`onLoadOlder`) and keeps the reader's place.
struct ConversationTranscript: View {
    let items: [ConversationItem]
    let documents: [String: MarkdownDocument]
    let pending: [PendingBubble]
    let emptyTitle: String
    let emptyMessage: String
    var onRetryPending: ((PendingBubble) -> Void)?
    var onDismissPending: ((PendingBubble) -> Void)?
    /// Older history exists above the first item.
    var hasOlder = false
    /// An older page request is currently in flight.
    var isLoadingOlder = false
    /// Changes after every older page read: the top row then asks for the next one if still shown.
    var olderPagesRead = 0
    var onLoadOlder: (() -> Void)?

    private struct ScrollPosition: Equatable { var isNearBottom = true; var isNearTop = false; var canScroll = false }

    @State private var toolRoute: ToolRoute?
    @State private var scrollPosition = ScrollPosition()
    @State private var isOlderRowVisible = false
    /// The first item shown when older history was requested, kept at the top once it arrives.
    @State private var olderAnchor: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct ToolRoute: Identifiable {
        let id: String
        let activity: ToolActivity
    }

    private var olderAutoLoadKey: String? {
        guard hasOlder, onLoadOlder != nil, !isLoadingOlder, isOlderRowVisible, scrollPosition.canScroll, scrollPosition.isNearTop else { return nil }
        return "\(olderPagesRead):\(items.first?.id ?? "")"
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if items.isEmpty && pending.isEmpty && !hasOlder {
                        ContentUnavailableView(emptyTitle, systemImage: "bubble.left.and.text.bubble.right", description: Text(emptyMessage))
                            .padding(.top, 60)
                    }
                    if hasOlder, let onLoadOlder {
                        Group {
                            if isLoadingOlder || scrollPosition.canScroll {
                                ProgressView().frame(maxWidth: .infinity, minHeight: 44).accessibilityLabel("Loading earlier messages")
                            } else {
                                Button { olderAnchor = items.first?.id; onLoadOlder() } label: {
                                    Text("Load earlier messages").font(.footnote.weight(.medium))
                                        .foregroundStyle(ArmadaTheme.textSecondary).frame(maxWidth: .infinity, minHeight: 44)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .id("older-\(olderPagesRead)")
                        .onAppear { isOlderRowVisible = true }
                        .onDisappear { isOlderRowVisible = false }
                    }
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        row(item)
                            .padding(.top, index == 0 ? 0 : spacing(before: item, after: items[index - 1]))
                            .id(item.id)
                    }
                    ForEach(pending) { bubble in
                        pendingRow(bubble)
                            .padding(.top, ChatBubbleLayout.standardSpacing)
                            .id("pending-\(bubble.id)")
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 16)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollIndicators(.hidden)
            // Initial placement belongs to layout; later content changes do not reapply it.
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .onScrollGeometryChange(for: ScrollPosition.self) { geometry in
                ScrollPosition(
                    isNearBottom: geometry.contentSize.height - geometry.visibleRect.maxY < 120,
                    isNearTop: geometry.visibleRect.minY <= 80,
                    canScroll: geometry.contentSize.height > geometry.visibleRect.height + 24
                )
            } action: { _, position in
                scrollPosition = position
            }
            .task(id: olderAutoLoadKey) {
                guard olderAutoLoadKey != nil, let onLoadOlder else { return }
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled, olderAutoLoadKey != nil else { return }
                olderAnchor = items.first?.id
                onLoadOlder()
            }
            .onChange(of: items.first?.id) { _, _ in
                // Older messages were added above: keep the message the reader was at in place.
                guard let anchor = olderAnchor else { return }
                olderAnchor = nil
                proxy.scrollTo(anchor, anchor: .top)
            }
            .onChange(of: items.last) { _, _ in
                guard scrollPosition.isNearBottom else { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .onChange(of: pending.count) { previous, current in
                // The person's own new message always brings the tail into view.
                guard current > previous else { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !scrollPosition.isNearBottom {
                    Button {
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) {
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(ArmadaTheme.textPrimary)
                            .frame(width: 44, height: 44)
                            .background(ArmadaTheme.card, in: Circle())
                            .overlay { Circle().stroke(ArmadaTheme.separator, lineWidth: 0.5) }
                    }
                    .buttonStyle(.plain)
                    .padding(.trailing, 16)
                    .padding(.bottom, 12)
                    .accessibilityLabel("Jump to latest")
                    .transition(reduceMotion ? .identity : .opacity)
                }
            }
        }
        .accessibilityIdentifier("chat.transcript")
        .sheet(item: $toolRoute) { route in
            ToolRunDetailView(activity: route.activity)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder
    private func row(_ item: ConversationItem) -> some View {
        switch item.kind {
        case .user(let text, let status, _):
            ChatMessageBubble(
                content: text,
                kind: .mine,
                footnote: status == .queued ? "Queued" : nil
            )
        case .steer(let text, _):
            ChatMessageBubble(content: text, kind: .mine, caption: "Steer")
        case .assistant(let text, let streaming, _):
            ChatMessageBubble(
                content: text,
                kind: .assistant,
                markdown: documents[item.key],
                streaming: streaming
            )
        case .tool(let activity):
            ToolRunCard(activity: activity) {
                toolRoute = ToolRoute(id: item.key, activity: activity)
            }
        case .outcome(let status, let reason):
            OutcomeRow(status: status, reason: reason)
        }
    }

    private func pendingRow(_ bubble: PendingBubble) -> some View {
        VStack(alignment: .trailing, spacing: 8) {
            ChatMessageBubble(
                content: bubble.text,
                kind: .mine,
                caption: bubble.intent == .steer ? "Steer" : nil,
                footnote: footnote(for: bubble.status)
            )
            if bubble.status == .unconfirmed {
                VStack(alignment: .trailing, spacing: 6) {
                    Text(onRetryPending == nil
                        ? "Armada did not confirm delivery. It appears above if Armada received it; Dismiss only hides it here."
                        : "Armada did not confirm delivery. Retry sends the same request again; Dismiss only hides it here, and it still appears if Armada received it.")
                        .font(.caption)
                        .foregroundStyle(ArmadaTheme.dangerText)
                        .multilineTextAlignment(.trailing)
                    HStack(spacing: 8) {
                        if let onDismissPending {
                            Button { onDismissPending(bubble) } label: {
                                Text("Dismiss").frame(minHeight: 44)
                            }
                            .buttonStyle(.glass)
                        }
                        if let onRetryPending {
                            Button { onRetryPending(bubble) } label: {
                                Text("Retry").frame(minHeight: 44)
                            }
                            .buttonStyle(.glassProminent)
                        }
                    }
                }
                .padding(.trailing, 4)
            }
        }
    }

    private func footnote(for status: PendingBubble.Status) -> String {
        switch status {
        case .sending: "Sending…"
        case .accepted: "Sent"
        case .unconfirmed: "Not confirmed"
        }
    }

    private func spacing(before item: ConversationItem, after previous: ConversationItem) -> CGFloat {
        if case .assistant = item.kind, case .assistant = previous.kind {
            return ChatBubbleLayout.consecutiveAssistantSpacing
        }
        if case .tool = item.kind, case .tool = previous.kind { return 6 }
        return ChatBubbleLayout.standardSpacing
    }
}

private struct OutcomeRow: View {
    let status: PromptStatus
    let reason: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: status == .interrupted ? "pause.circle" : "exclamationmark.triangle")
                .foregroundStyle(status == .interrupted ? ArmadaTheme.warningText : ArmadaTheme.dangerText)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(status == .interrupted ? "Turn interrupted" : "Turn failed")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(ArmadaTheme.textPrimary)
                if status == .interrupted || reason != nil {
                    Text(status == .interrupted ? SandboxPresentation.interruption(reason) : SandboxPresentation.sandboxFailure(reason))
                        .font(.footnote)
                        .foregroundStyle(ArmadaTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
