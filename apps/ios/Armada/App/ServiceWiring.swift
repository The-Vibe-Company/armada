import ArmadaKit

/// The one place the presentation's services are bound to the client. Both run over the actual
/// `ArmadaKit` client; capability and authorization come from the server through it.
enum ServiceWiring {
    static func orchestrators(client: ArmadaClient) -> any OrchestratorService {
        ArmadaKitServices(client: client)
    }

    static func sandboxes(client: ArmadaClient) -> any SandboxService {
        ArmadaKitServices(client: client)
    }
}
