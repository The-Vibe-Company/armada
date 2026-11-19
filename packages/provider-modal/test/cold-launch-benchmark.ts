import { modalConnection } from "../src/client.ts";

const usage =
  "Usage: bun packages/provider-modal/test/cold-launch-benchmark.ts IMAGE ARMADA_REF ARMADA_SHA SMALL_URL SMALL_REF SMALL_SHA SMALL_INIT";
const checkout = "/tmp/armada-cold-launch";
const sampleCount = 5;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} for the dedicated staging Modal app.`);
  return value;
}

async function main() {
  const [imageRef, armadaRef, armadaSha, smallUrl, smallRef, smallSha, smallInit, ...extra] = process.argv.slice(2);
  if (imageRef === "--help") {
    console.log(usage);
    return;
  }
  if (
    extra.length ||
    !imageRef ||
    !/^ghcr\.io\/the-vibe-company\/armada-sandbox@sha256:[a-f0-9]{64}$/.test(imageRef) ||
    !armadaRef ||
    !armadaSha ||
    !smallUrl ||
    !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(smallUrl) ||
    /^https:\/\/github\.com\/the-vibe-company\/armada\.git$/i.test(smallUrl) ||
    !smallRef ||
    !smallSha ||
    ![armadaSha, smallSha].every((sha) => /^[a-f0-9]{40}$/.test(sha)) ||
    !smallInit?.trim()
  ) {
    throw new Error(usage);
  }

  const workloads = [
    {
      name: "armada",
      url: "https://github.com/The-Vibe-Company/armada.git",
      ref: armadaRef,
      sha: armadaSha,
      init: "bun install --frozen-lockfile",
    },
    { name: "small", url: smallUrl, ref: smallRef, sha: smallSha, init: smallInit },
  ];
  const appName = requiredEnv("COLD_MODAL_APP");
  const environment = requiredEnv("COLD_MODAL_ENVIRONMENT");
  const client = modalConnection({
    tokenId: requiredEnv("MODAL_TOKEN_ID"),
    tokenSecret: requiredEnv("MODAL_TOKEN_SECRET"),
  });
  const batch = crypto.randomUUID().slice(0, 12);

  try {
    const app = await client.apps.fromName(appName, { environment, createIfMissing: false });
    console.log(JSON.stringify({ batch, appName, environment, imageRef, workloads, sampleCount }));
    const samples = workloads.map(() => [] as Record<string, number>[]);
    for (let run = 1; run <= sampleCount; run++) {
      for (const [index, workload] of workloads.entries()) {
        const name = `cold-init-${batch}-${workload.name}-${run}`;
        let phase = "image";
        let sandbox: Awaited<ReturnType<typeof client.sandboxes.create>> | undefined;
        let result: { sandboxId: string; times: Record<string, number> } | undefined;
        let failure: Error | undefined;
        console.log(JSON.stringify({ event: "attempt", name }));
        try {
          const start = performance.now();
          const image = await client.images.fromRegistry(imageRef).build(app);
          const imageReady = performance.now();

          phase = "allocation";
          sandbox = await client.sandboxes.create(app, image, {
            name,
            command: ["sleep", "infinity"],
            timeoutMs: 600_000,
            includeOidcIdentityToken: false,
          });
          const machine = sandbox;
          async function exec(command: string[], workdir: string) {
            const child = await machine.exec(command, {
              workdir,
              env: { GIT_TERMINAL_PROMPT: "0", BUN_INSTALL_CACHE_DIR: "/tmp/armada-bun-cache" },
              stdout: "ignore",
              stderr: "ignore",
            });
            const code = await child.wait();
            if (code !== 0) throw new Error(`Guest command exited with code ${code}`);
          }

          await exec(["true"], "/tmp");
          const allocated = performance.now();

          phase = "clone";
          await exec(
            [
              "sh",
              "-ec",
              'git clone --depth=3 --branch "$1" -- "$2" "$3" && test "$(git -C "$3" rev-parse HEAD)" = "$4"',
              "clone",
              workload.ref,
              workload.url,
              checkout,
              workload.sha,
            ],
            "/tmp",
          );
          const cloned = performance.now();

          phase = "init";
          await exec(["bash", "-ec", workload.init], checkout);
          const initialized = performance.now();
          const times = {
            imageMs: imageReady - start,
            allocationMs: allocated - imageReady,
            cloneMs: cloned - allocated,
            initMs: initialized - cloned,
            totalMs: initialized - start,
          };
          result = { sandboxId: sandbox.sandboxId, times };
        } catch (error) {
          failure = new Error(`${name} failed during ${phase}`, { cause: error });
        }
        if (sandbox) {
          try {
            await sandbox.terminate({ wait: true });
          } catch (error) {
            const cleanup = new Error(`Cleanup failed for ${name} (${sandbox.sandboxId})`, { cause: error });
            throw failure ? new AggregateError([failure, cleanup], `${name} failed and cleanup also failed`) : cleanup;
          }
        }
        if (!result) throw failure;
        samples[index]?.push(result.times);
        console.log(
          JSON.stringify({ workload: workload.name, run, name, sandboxId: result.sandboxId, ...result.times }),
        );
      }
    }

    for (const [index, workload] of workloads.entries()) {
      const runs = samples[index] ?? [];
      const summary = Object.fromEntries(
        ["imageMs", "allocationMs", "cloneMs", "initMs", "totalMs"].map((stage) => {
          const sorted = runs.map((run) => run[stage] ?? Number.NaN).sort((a, b) => a - b);
          return [
            stage,
            { p50: sorted[Math.ceil(0.5 * sorted.length) - 1], p95: sorted[Math.ceil(0.95 * sorted.length) - 1] },
          ];
        }),
      );
      console.log(JSON.stringify({ workload: workload.name, n: runs.length, summary }));
    }
  } finally {
    client.close();
  }
}

await main();
