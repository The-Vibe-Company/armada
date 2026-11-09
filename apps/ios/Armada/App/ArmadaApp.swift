import SwiftUI

/// The single app entrypoint (#689 builds target `Armada` from `apps/ios/Armada`).
@main
struct ArmadaApp: App {
    @State private var model = AppModel.live()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}
