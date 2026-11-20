import {
  Armada,
  type FailureCode,
  type GoldenLaunchInput,
  type LaunchResult,
  type SendInput,
} from "@the-vibe-company/armada-sdk";

const code: FailureCode = "outcome_unknown";
export type ContractFailureCode = Assert<Equal<Extract<FailureCode, "provider_mismatch">, "provider_mismatch">>;
export type UnknownCodesExcluded = Assert<Equal<Extract<"arbitrary_failure", FailureCode>, never>>;

const client = new Armada({ token: code });
const boat = () => client.launch({ provider: "boat", golden: "worker", harness: "codex" });
const modal = () => client.launch({ provider: "modal", golden: "worker", harness: "codex" });
const pinnedModal = () =>
  client.launch({
    provider: "modal",
    runtimeVersion: 1,
    runtimeTransport: "dialout",
    harness: "codex",
    id: "revision-owner-template-id",
    revision: 1,
    idempotencyKey: "pinned-modal-smoke",
    externalRef: "test:modal",
  });
const docker = () =>
  client.launch({
    org: "o",
    provider: "docker",
    hostId: "h",
    harness: "codex",
    idempotencyKey: "saved-launch-key-0001",
  });

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type LogsInputContract = Assert<
  Equal<Extract<"conversationId" | "conversation_id", keyof Parameters<Armada["logs"]>[0]>, never>
>;

export type SendInputContract = Assert<Equal<Extract<"conversationId" | "conversation_id", keyof SendInput>, never>>;

export type BoatReceiptContract = Assert<Equal<Awaited<ReturnType<typeof boat>>, LaunchResult>>;
export type PinnedModalReceiptContract = Assert<Equal<Awaited<ReturnType<typeof pinnedModal>>, LaunchResult>>;
export type ModalReceiptContract = Assert<Equal<Awaited<ReturnType<typeof modal>>, LaunchResult>>;
export type DockerReceiptContract = Assert<Equal<Awaited<ReturnType<typeof docker>>, LaunchResult>>;
export type LaunchFields = Assert<
  Equal<
    Pick<LaunchResult, "promptId" | "conversationId" | "expiresAt" | "runtime">,
    {
      promptId: string | null;
      conversationId: string | null;
      expiresAt: string | null;
      runtime: { kind: "armada"; epoch: string } | null;
    }
  >
>;
export type LaunchSandboxIdentity = Assert<Equal<LaunchResult["sandbox"]["providerSandboxId"], string>>;

export type GoldenProviderIsRequired = Assert<Equal<GoldenLaunchInput["provider"], "boat" | "modal">>;
