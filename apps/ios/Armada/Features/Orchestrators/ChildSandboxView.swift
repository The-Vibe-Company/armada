import SwiftUI

struct ChildSandboxRoute: Hashable {
    let id: String
}

/// A worker sandbox an orchestrator launched, opened on the existing sandbox screen. The
/// organization's sandbox list (`sandbox/list`, the allowlisted metadata every member may read) is
/// paged until the id appears; the sandbox screen then reauthorizes its conversation as usual.
struct ChildSandboxView: View {
    let sandboxID: String

    /// Bounded search: the newest sandboxes come first and a worker is usually recent.
    private static let maximumPages = 8

    @Environment(AppModel.self) private var app
    @State private var phase: Phase = .loading

    private enum Phase {
        case loading
        case found(SandboxSummary)
        case missing
        case failed(ServiceFailure)
    }

    var body: some View {
        Group {
            switch phase {
            case .loading:
                SurfaceStateView(state: .loading("Loading worker…"))
            case .found(let sandbox):
                SandboxDetailView(sandbox: sandbox)
            case .missing:
                SurfaceStateView(state: .empty(
                    title: "Worker not listed",
                    message: "This sandbox is no longer in the organization's list. It may have been deleted.",
                    symbol: "shippingbox"
                ))
            case .failed(let failure):
                switch failure {
                case .unavailable(let reason):
                    SurfaceStateView(state: .unavailable(reason))
                default:
                    SurfaceStateView(state: .failure(failure.message, retry: { Task { await resolve() } }))
                }
            }
        }
        .background(ArmadaTheme.canvas)
        .navigationTitle("Worker")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: sandboxID) { await resolve() }
    }

    private func resolve() async {
        guard let orgID = app.organization?.id else { return }
        phase = .loading
        var page: Int? = 1
        var read = 0
        do throws(ServiceFailure) {
            while let current = page, read < Self.maximumPages {
                let result = try await app.sandboxes.list(orgID: orgID, page: current)
                if let match = result.items.first(where: { $0.id == sandboxID }) {
                    phase = .found(match)
                    return
                }
                page = result.nextPage
                read += 1
            }
            phase = .missing
        } catch {
            if error == .signedOut { app.sessionEnded() }
            phase = .failed(error)
        }
    }
}
