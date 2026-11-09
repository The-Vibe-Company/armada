import ArmadaKit

/// The one place the presentation's services meet `ArmadaKit`.
///
/// `ArmadaKit`'s published surface (#690, `codex/690-ios` `b21ba00`) offers sign-in, session and
/// organization selection only; it does not yet publish orchestrator or sandbox requests, and the
/// server's `/api/v1/orchestrators` routes are a proposed v1 contract with the feature off. The
/// app therefore reports both capabilities as unavailable at runtime. When ArmadaKit publishes
/// those requests, adapt them here (DTO -> `OrchestratorSummary`, `SandboxSummary`,
/// `OrchestratorEventPage`; `ArmadaError` -> `ServiceFailure`) and nowhere else.
enum ServiceWiring {
    static func orchestrators(client: ArmadaClient) -> any OrchestratorService {
        UnavailableServices.orchestrators
    }

    static func sandboxes(client: ArmadaClient) -> any SandboxService {
        UnavailableServices.sandboxes
    }
}
