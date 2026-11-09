import SwiftUI
import UIKit

/// How a message reaches the agent while one of its turns runs. The server decides; the choice only
/// selects which owner action is sent.
enum ComposerIntent: Hashable, Sendable {
    /// Continue the native conversation with a new turn (queued behind a running one).
    case message
    /// Reach the running turn now.
    case steer
}

/// The capsule composer of Companion `8e01b209` (`ChatComposer.swift`), without attachments or
/// voice, which Armada does not offer. The draft lives in the screen model so a stale-revision
/// refusal can hand it back untouched.
struct ChatComposer: View {
    @Binding var draft: String
    let placeholder: String
    /// Nil when sending is possible; otherwise the reason shown instead of the field.
    let unavailableReason: String?
    let isAgentWorking: Bool
    let agentName: String
    let steerRestartsTurn: Bool
    let sending: Bool
    let onSend: (String, ComposerIntent) -> Void

    @State private var intent: ComposerIntent = .steer
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 8) {
            if isAgentWorking {
                AgentWorkingStatus(agentName: agentName)
                    .transition(reduceMotion ? .identity : .move(edge: .bottom).combined(with: .opacity))
            }
            if let unavailableReason {
                Label(unavailableReason, systemImage: "pause.circle")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(ArmadaTheme.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .padding(.horizontal, 16)
                    .background(ArmadaTheme.card, in: Capsule())
                    .accessibilityIdentifier("chat.composer-unavailable")
            } else {
                if isAgentWorking {
                    intentPicker
                }
                inputBar
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background(ArmadaTheme.canvas)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: isAgentWorking)
        .accessibilityIdentifier("chat.composer-controls")
    }

    private var intentPicker: some View {
        Picker("While the agent works", selection: $intent) {
            Text("Steer now").tag(ComposerIntent.steer)
            Text("Queue next").tag(ComposerIntent.message)
        }
        .pickerStyle(.segmented)
        .accessibilityHint(
            steerRestartsTurn
                ? "Steer interrupts the running turn and continues with your message."
                : "Steer adds your message to the running turn."
        )
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 4) {
            TextField(placeholder, text: $draft, axis: .vertical)
                .font(.body)
                .foregroundStyle(ArmadaTheme.textPrimary)
                .lineLimit(1...6)
                .focused($focused)
                .padding(.leading, 14)
                .padding(.trailing, 6)
                .padding(.vertical, 11)
                .accessibilityIdentifier("chat.composer")

            Button(action: send) {
                Group {
                    if sending {
                        ProgressView()
                            .controlSize(.small)
                            .tint(ArmadaTheme.primaryCTAText)
                    } else {
                        Image(systemName: effectiveIntent == .steer ? "arrow.turn.down.right" : "arrow.up")
                    }
                }
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(ArmadaTheme.primaryCTAText)
                .frame(width: 44, height: 44)
                .background(ArmadaTheme.primaryCTA, in: Circle())
                .opacity(sendDisabled ? 0.4 : 1)
            }
            .buttonStyle(.plain)
            .disabled(sendDisabled)
            .accessibilityLabel(effectiveIntent == .steer ? "Steer the running turn" : "Send message")
            .accessibilityIdentifier("chat.send")
        }
        .padding(4)
        .background(ArmadaTheme.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    }

    private var effectiveIntent: ComposerIntent { isAgentWorking ? intent : .message }

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var sendDisabled: Bool { sending || trimmed.isEmpty || unavailableReason != nil }

    private func send() {
        guard !sendDisabled else { return }
        let text = trimmed
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        onSend(text, effectiveIntent)
    }
}
