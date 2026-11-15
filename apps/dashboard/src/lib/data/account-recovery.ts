import type { Harness } from "@armada/core";
import { type AccountOption, accountChoiceReadFailure, compatibleAccounts } from "@/lib/account-recovery";
import { CAPABILITIES_TIMEOUT_MS, ControlError, createControlClient } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import type { Viewer } from "./viewer";

export type AccountChoices = { state: "ready"; accounts: AccountOption[] } | { state: "unavailable"; message: string };

/** The accounts the owner may bind, read as safe metadata from `creds/list` for the sandbox's org; never a value. */
export async function readAccountChoices(viewer: Viewer, harness: Harness, orgId: string): Promise<AccountChoices> {
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token)
    return {
      state: "unavailable",
      message:
        "Account setup is not ready here. Ask an Armada administrator to finish setup, then reload this sandbox.",
    };
  try {
    const list = await createControlClient({ serverUrl, token: viewer.token, timeoutMs: CAPABILITIES_TIMEOUT_MS }).post(
      "creds/list",
      { org: orgId },
    );
    return { state: "ready", accounts: compatibleAccounts(list, harness, orgId, new Date()) };
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return { state: "unavailable", message: accountChoiceReadFailure(error.status) };
  }
}
