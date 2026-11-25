import {
  Armada,
  type FailureCode,
  type GoldenLaunchInput,
  type LaunchResult,
  type ModalLaunchReceipt,
  type PinnedModalLaunchReceipt,
  type SendInput,
} from "@the-vibe-company/armada-sdk";

const code: FailureCode = "outcome_unknown";
export type ContractFailureCode = Assert<Equal<Extract<FailureCode, "provider_mismatch">, "provider_mismatch">>;
export type UnknownCodesExcluded = Assert<Equal<Extract<"arbitrary_failure", FailureCode>, never>>;

const client = new Armada({ token: code });
const boat = () => client.launch({ provider: "boat", golden: "worker", harness: "codex" });
const modal = () => client.launch({ provider: "modal", golden: "worker", harness: "antigravity", model: "default" });
const pinnedModal = () =>
  client.launch({
    provider: "modal",
    runtimeVersion: 1,
    modalTransport: "dialout",
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

const invalidBoatRuntime = () =>
  // @ts-expect-error A launch with runtimeVersion requires the complete explicit runtime variant.
  client.launch({ provider: "boat", golden: "worker", harness: "codex", runtimeVersion: 1 });
void invalidBoatRuntime;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type LogsInputContract = Assert<
  Equal<Extract<"conversationId" | "conversation_id", keyof Parameters<Armada["logs"]>[0]>, never>
>;

export type LogsOutputContract = Assert<Equal<Awaited<ReturnType<Armada["logs"]>>["queuedPrompt"], unknown>>;

export type SendInputContract = Assert<Equal<Extract<"conversationId" | "conversation_id", keyof SendInput>, never>>;

type FullLaunchResult = Exclude<LaunchResult, ModalLaunchReceipt>;
export type BoatReceiptContract = Assert<Equal<Awaited<ReturnType<typeof boat>>, FullLaunchResult>>;
export type PinnedModalReceiptContract = Assert<
  Equal<Awaited<ReturnType<typeof pinnedModal>>, PinnedModalLaunchReceipt>
>;
export type ModalReceiptContract = Assert<Equal<Awaited<ReturnType<typeof modal>>, ModalLaunchReceipt>>;
export type DockerReceiptContract = Assert<Equal<Awaited<ReturnType<typeof docker>>, ModalLaunchReceipt>>;
export type LaunchFields = Assert<
  Equal<
    Pick<FullLaunchResult, "promptId" | "conversationId" | "expiresAt" | "runtime">,
    {
      promptId: string | null;
      conversationId: string | null;
      expiresAt: string | null;
      runtime: { kind: "armada"; epoch: string } | null;
    }
  >
>;
export type LaunchSandboxIdentity = Assert<Equal<FullLaunchResult["sandbox"]["providerSandboxId"], string>>;

export type GoldenProviderIsRequired = Assert<Equal<GoldenLaunchInput["provider"], "boat" | "modal">>;

type SandboxListItem = Awaited<ReturnType<Armada["list"]>>["sandboxes"][number];
export type ListSandboxIdentity = Assert<Equal<SandboxListItem["providerSandboxId"], string | null>>;
export type ListBoatAliasRemoved = Assert<Equal<Extract<"boatId", keyof SandboxListItem>, never>>;

export type DockerStatusSnapshot = Assert<
  Equal<Awaited<ReturnType<Armada["status"]>>["snapshotId"], string | undefined>
>;
export type StatusProviderIsRequired = Assert<
  Equal<Awaited<ReturnType<Armada["status"]>>["provider"], "boat" | "modal" | "docker">
>;

export type ModalReceiptFields = Assert<Equal<keyof ModalLaunchReceipt, "sandbox">>;
