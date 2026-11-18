// PR typechecking resolves the workspace source. The npm smoke resolves the installed declarations.
import { Armada, type FailureCode } from "@the-vibe-company/armada-sdk";

const code: FailureCode = "outcome_unknown";

export async function golden(provider: "boat" | "modal") {
  const receipt = await new Armada({ token: code }).launch({ provider, golden: "worker", harness: "codex" });
  return { golden: receipt.golden.id, prompt: receipt.promptId, conversation: receipt.conversationId };
}

export async function docker() {
  const receipt = await new Armada({ token: code }).launch({
    org: "o",
    provider: "docker",
    hostId: "h",
    harness: "codex",
    requestId: "r",
  });
  return {
    golden: receipt.golden,
    host: receipt.sandbox.hostId,
    prompt: receipt.promptId,
    conversation: receipt.conversationId,
  };
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type GoldenReceiptContract = Assert<
  Equal<Awaited<ReturnType<typeof golden>>, { golden: string; prompt: string | null; conversation: string | null }>
>;
export type DockerReceiptContract = Assert<
  Equal<
    Awaited<ReturnType<typeof docker>>,
    { golden: null; host: string; prompt: string | null | undefined; conversation: string | null | undefined }
  >
>;
