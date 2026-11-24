import { createTemplateService, GoldenError, type Sql, VaultError } from "@armada/core/server";

export async function templateLaunchAuthorized(tx: Sql, sandboxId: string) {
  try {
    await createTemplateService(tx).revalidateGoldenJob(tx, sandboxId);
    return true;
  } catch (error) {
    if (error instanceof VaultError || error instanceof GoldenError) return false;
    throw error;
  }
}
