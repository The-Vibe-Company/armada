import ArmadaKit

/// The one place the presentation's services are bound to the client. It runs over the actual
/// `ArmadaKit` client; capability and authorization come from the server through it.
enum ServiceWiring {
    static func sandboxes(client: ArmadaClient) -> any SandboxService {
        ArmadaKitServices(client: client)
    }
}
