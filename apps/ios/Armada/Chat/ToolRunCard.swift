import SwiftUI

/// A compact transcript entry for one tool call, adapted from Companion `8e01b209`
/// (`ToolRunCard.swift`). Tool payloads are untrusted transcript text: the detail sheet renders
/// them literally, never as Markdown or HTML. A stable screen ancestor owns presentation so
/// polling cannot dismiss the sheet the reader has open.
struct ToolRunCard: View {
    let activity: ToolActivity
    let onOpenDetails: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Button(action: onOpenDetails) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: activity.family.systemImage)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ArmadaTheme.textSecondary)
                    .frame(width: 28, height: 28)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Tool · \(activity.displayName)")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(ArmadaTheme.textSecondary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                        .truncationMode(.middle)
                    if !activity.summary.isEmpty {
                        Text(activity.summary)
                            .font(.footnote.monospaced())
                            .foregroundStyle(ArmadaTheme.textSecondary)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                            .truncationMode(.middle)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                ToolRunStatusView(status: activity.status, reduceMotion: reduceMotion)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ArmadaTheme.textSecondary)
                    .frame(width: 20, height: 44)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: 520, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background {
                Capsule()
                    .fill(ArmadaTheme.chip)
                    .overlay {
                        if activity.status == .failed {
                            Capsule().fill(ArmadaTheme.danger.opacity(0.08))
                        }
                    }
            }
            .overlay {
                Capsule().stroke(activity.status == .failed ? ArmadaTheme.danger : .clear, lineWidth: 1)
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Tool \(activity.displayName), \(activity.status.label)")
        .accessibilityHint("Opens details")
    }
}

struct ToolRunDetailView: View {
    let activity: ToolActivity

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        Label(activity.family.label, systemImage: activity.family.systemImage)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ArmadaTheme.textSecondary)
                        Text(activity.displayName)
                            .font(.title2.weight(.semibold).monospaced())
                            .foregroundStyle(ArmadaTheme.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                        HStack(spacing: 14) {
                            ToolRunStatusView(status: activity.status, reduceMotion: reduceMotion)
                            Label(activity.at.formatted(date: .abbreviated, time: .standard), systemImage: "clock")
                                .font(.caption)
                                .foregroundStyle(ArmadaTheme.textSecondary)
                        }
                    }
                    payload(title: "Input", text: ToolPayloadText.text(activity.call.input))
                    if let result = activity.call.result {
                        payload(title: result.isError ? "Error" : "Result", text: ToolPayloadText.text(result.output))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.vertical, 18)
            }
            .background(ArmadaTheme.canvas)
            .navigationTitle("Tool Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func payload(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
                .foregroundStyle(ArmadaTheme.textPrimary)
            if text.isEmpty {
                Text("Nothing was recorded.")
                    .font(.subheadline)
                    .foregroundStyle(ArmadaTheme.textSecondary)
            } else {
                ScrollView(.horizontal) {
                    Text(text)
                        .font(.system(.callout, design: .monospaced))
                        .foregroundStyle(ArmadaTheme.textPrimary)
                        .fixedSize(horizontal: true, vertical: false)
                        .textSelection(.enabled)
                        .padding(14)
                }
                .scrollIndicators(.visible)
                .armadaCard(radius: 12)
            }
        }
    }
}

private struct ToolRunStatusView: View {
    let status: ToolActivity.Status
    let reduceMotion: Bool

    var body: some View {
        HStack(spacing: 5) {
            if status == .running, !reduceMotion {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityHidden(true)
            } else {
                Image(systemName: status.systemImage)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(status.color)
                    .accessibilityHidden(true)
            }
            Text(status.label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(ArmadaTheme.textPrimary)
                .lineLimit(1)
        }
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Status: \(status.label)")
    }
}

extension ToolActivity {
    enum Status: Equatable {
        case running
        case done
        case failed

        var label: String {
            switch self {
            case .running: "Running"
            case .done: "Done"
            case .failed: "Failed"
            }
        }

        var systemImage: String {
            switch self {
            case .running: "arrow.triangle.2.circlepath"
            case .done: "checkmark.circle.fill"
            case .failed: "exclamationmark.octagon.fill"
            }
        }

        var color: Color {
            switch self {
            case .running: ArmadaTheme.actionBlue
            case .done: ArmadaTheme.live
            case .failed: ArmadaTheme.danger
            }
        }
    }

    enum Family {
        case shell
        case file
        case search
        case web
        case agent
        case tool

        var label: String {
            switch self {
            case .shell: "Shell"
            case .file: "File"
            case .search: "Search"
            case .web: "Web"
            case .agent: "Agent"
            case .tool: "Tool"
            }
        }

        var systemImage: String {
            switch self {
            case .shell: "terminal"
            case .file: "doc.text"
            case .search: "magnifyingglass"
            case .web: "globe"
            case .agent: "person.2"
            case .tool: "wrench.and.screwdriver"
            }
        }
    }

    var status: Status {
        guard let result = call.result else { return .running }
        return result.isError ? .failed : .done
    }

    var displayName: String { call.name.isEmpty ? "Unnamed tool" : call.name }

    var summary: String { ToolPayloadText.summary(call.input) }

    /// A presentation family from the tool name only; it never changes what is shown as payload.
    var family: Family {
        let name = call.name.lowercased()
        if ["bash", "shell", "exec", "exec_command", "local_shell"].contains(name) { return .shell }
        if ["read", "write", "edit", "multiedit", "apply_patch", "notebookedit"].contains(name) { return .file }
        if ["grep", "glob", "ls"].contains(name) { return .search }
        if ["webfetch", "websearch", "web_search"].contains(name) { return .web }
        if ["task", "agent"].contains(name) { return .agent }
        return .tool
    }
}
