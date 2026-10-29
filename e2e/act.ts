import { test } from "@e2e-dev/web";
import { type credentials, isAgentError, type TestFixtures } from "e2e";
import { CACHE_MISS } from "./replay-only";

export async function act(
  agent: TestFixtures["agent"],
  goal: string,
  params?: Record<string, string | ReturnType<typeof credentials.user>["password"]>,
) {
  try {
    await agent.act(goal, { params });
  } catch (error) {
    if (isAgentError(error) && error.code === "MODEL_UNAVAILABLE" && error.message === CACHE_MISS) {
      test.skip(CACHE_MISS);
    }
    throw error;
  }
}
