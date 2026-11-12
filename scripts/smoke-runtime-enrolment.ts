/** Coordinator-only staging diagnostic. No host compute or model call; never prints capabilities/config. */
import { createRuntimeEnrolments } from "../packages/mcp-server/src/runtime-enrolment.ts";
import { bunSql } from "../packages/mcp-server/src/sql.ts";

async function main() {
  if (process.env.ARMADA_RUNTIME_ENROLMENT_SMOKE !== "use_disposable_staging_sandbox")
    throw Error("staging_smoke_not_enabled");
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw Error("staging_smoke_configuration_missing");
    return value;
  };
  const origin = new URL(required("ARMADA_STAGING_URL"));
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw Error("staging_smoke_invalid_origin");
  const sql = bunSql(required("ARMADA_STAGING_DATABASE_URL"));
  try {
    const service = createRuntimeEnrolments(sql, required("ARMADA_STAGING_ENCRYPTION_KEY"));
    const sandboxId = required("ARMADA_STAGING_SANDBOX_ID");
    const ownerId = required("ARMADA_STAGING_OWNER_ID");
    async function request(path: string, token: string, epoch?: string) {
      return fetch(new URL(`/api/runtime/${path}`, origin), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${token}`, ...(epoch ? { "x-armada-runtime-epoch": epoch } : {}) },
      });
    }
    async function exchange() {
      const { enrolmentToken } = await service.issue({
        sandboxId,
        ownerId,
        configuration: { marker: "staging-enrolment-smoke" },
      });
      const response = await request("enrol", enrolmentToken);
      if (response.status !== 200 || response.headers.get("cache-control") !== "no-store")
        throw Error("staging_exchange_failed");
      const result = (await response.json()) as {
        epoch: string;
        runtimeToken: string;
        configuration: { marker: string };
      };
      if (
        result.configuration.marker !== "staging-enrolment-smoke" ||
        (await request("enrol", enrolmentToken)).status !== 401
      )
        throw Error("staging_single_use_failed");
      return result;
    }
    const first = await exchange();
    if ((await request("session", first.runtimeToken, first.epoch)).status !== 200)
      throw Error("staging_session_failed");
    const second = await exchange();
    if (
      BigInt(second.epoch) <= BigInt(first.epoch) ||
      (await request("session", first.runtimeToken, first.epoch)).status !== 401 ||
      (await request("session", second.runtimeToken, first.epoch)).status !== 401 ||
      (await request("session", second.runtimeToken, second.epoch)).status !== 200
    )
      throw Error("staging_epoch_fence_failed");
    console.log("Runtime enrolment staging smoke passed: single-use exchange and replacement epoch fencing");
  } finally {
    await sql.close();
  }
}
void main().catch(() => {
  console.error("runtime_enrolment_staging_smoke_failed");
  process.exitCode = 1;
});
