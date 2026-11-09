import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectGolden,
  createGoldenCreateService,
  createSqlGoldenStore,
  createSqlVaultStore,
  encryptSecret,
  type GoldenActor,
  snapshotGolden,
} from "@armada/core/server";
import {
  createModalProvider,
  createSqlModalStore,
  type Machine,
  type RunnerDistribution,
  type Scope,
} from "@armada/provider-modal";
import type { Image, ModalClient, Sandbox } from "modal";
import { database, ENCRYPTION_KEY } from "./support.ts";

test("secure Modal golden publishes a NULL master, restores from its own image, and snapshots again", async () => {
  const { db, people } = await database();
  const files = await mkdtemp(join(tmpdir(), "armada-golden-images-"));
  try {
    const actor: GoldenActor = { orgId: people.org, userId: people.admin, role: "admin" };
    const scope: Scope = {
      orgId: people.org,
      userId: people.admin,
      visibility: "org",
      binding: { workspace: "ws", environment: "main", appId: "ap-immutable" },
    };
    const store = createSqlModalStore(db, scope);
    const machines = new Map<string, { sandbox: Sandbox; terminated: boolean; directory: string }>();
    const imageDirectories = new Map<string, string>();
    let snapshots = 0;
    let failNextPoll: string | undefined;
    const client = {
      apps: { fromName: async () => ({ appId: scope.binding.appId }) },
      images: { fromId: async (imageId: string) => ({ imageId }), delete: async () => {} },
      sandboxes: {
        create: async (_app: unknown, image: { imageId: string }) => {
          const sandboxId = `physical-${machines.size + 1}`;
          const directory = join(files, sandboxId);
          await mkdir(directory);
          const sourceImage = imageDirectories.get(image.imageId);
          if (sourceImage) await cp(sourceImage, directory, { recursive: true });
          const physical = { terminated: false, sandbox: {} as Sandbox, directory };
          physical.sandbox = {
            sandboxId,
            exec: async () => {
              let input = "";
              let complete!: (value: string) => void;
              const output = new Promise<string>((resolve) => {
                complete = resolve;
              });
              return {
                stdin: {
                  writeText: async (text: string) => {
                    input += text;
                  },
                  close: async () => {
                    const request = JSON.parse(input) as { command: string };
                    const command = request.command;
                    let result = {
                      detached: false,
                      exitCode: 0 as number | null,
                      stdout: "",
                      stderr: "",
                      timedOut: false,
                      truncated: false,
                    };
                    if (
                      [
                        "printf revision-one > revision.txt",
                        "printf revision-two > revision.txt",
                        "cat revision.txt",
                      ].includes(command)
                    ) {
                      const done = spawnSync("/bin/bash", ["-c", command], {
                        cwd: directory,
                        env: { PATH: "/usr/bin:/bin", HOME: directory },
                        encoding: "utf8",
                      });
                      result = { ...result, exitCode: done.status, stdout: done.stdout, stderr: done.stderr };
                    }
                    complete(JSON.stringify(result));
                  },
                },
                stdout: { readText: () => output },
                wait: async () => {
                  await output;
                  return 0;
                },
              };
            },
            poll: async () => {
              if (failNextPoll === sandboxId) {
                failNextPoll = undefined;
                throw new Error("fixture readiness unavailable");
              }
              return physical.terminated ? 0 : null;
            },
            terminate: async () => {
              physical.terminated = true;
            },
            snapshotFilesystem: async () => {
              const imageId = `im-${++snapshots}`;
              const destination = join(files, imageId);
              await cp(directory, destination, { recursive: true });
              imageDirectories.set(imageId, destination);
              return { imageId };
            },
          } as unknown as Sandbox;
          machines.set(sandboxId, physical);
          return physical.sandbox;
        },
        fromId: async (id: string) => {
          const physical = machines.get(id);
          if (!physical) throw new Error("Unexpected physical ID.");
          return physical.sandbox;
        },
      },
    } as unknown as ModalClient;
    const capabilities = {
      steer: "native" as const,
      interrupt: true,
      resume: true,
      parallelConversations: true,
      reasoningEffort: true,
      fast: true,
      streamsPartials: true,
      toolEvents: true,
      approvals: false,
    };
    const distribution: RunnerDistribution = {
      capabilities: { claude: capabilities, codex: { ...capabilities, steer: "restart" } },
      image: async () => ({ imageId: "im-base" }) as Image,
      start: async () => {},
      restoreEnv: async () => ({}),
      prepareSnapshot: async () => {},
    };
    const providerOptions = {
      scope,
      store,
      client,
      tokenId: "ak-synthetic",
      tokenSecret: "as-synthetic",
      appName: "bound",
      distribution,
      runner: {
        async call<T>(row: Machine, op: string, input: object) {
          if (op === "health") return { generation: String(row.generation), ready: true } as T;
          if (op === "checkpoint")
            return { generation: String(row.generation), watermark: 0, acknowledgedSequence: 0 } as T;
          if (op === "exec") {
            const command = (input as { input: { command: string } }).input.command;
            // Real file edits/reads in each physical fixture directory, not an assertion-shaped
            // snapshot receipt. The unrelated scan transport remains covered by the OS/SSH test.
            if (
              ["printf revision-one > revision.txt", "printf revision-two > revision.txt", "cat revision.txt"].includes(
                command,
              )
            ) {
              const directory = machines.get(row.physicalId!)!.directory;
              const result = spawnSync("/bin/bash", ["-c", command], {
                cwd: directory,
                env: { PATH: "/usr/bin:/bin", HOME: directory },
                encoding: "utf8",
              });
              return {
                detached: false,
                exitCode: result.status,
                stdout: result.stdout,
                stderr: result.stderr,
                timedOut: false,
                truncated: false,
              } as T;
            }
            return { detached: false, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false } as T;
          }
          throw new Error(`Unexpected runner operation: ${op}`);
        },
      },
    };
    const provider = createModalProvider(providerOptions);
    const secondaryActor: GoldenActor = { ...actor, userId: people.owner };
    const secondaryScope: Scope = { ...scope, userId: people.owner };
    const secondaryProvider = createModalProvider({
      ...providerOptions,
      scope: secondaryScope,
      store: createSqlModalStore(db, secondaryScope),
    });
    await db.query(
      "insert into github_connections(user_id,github_id,login,refresh_token_enc) values($1,7,'builder',$2)",
      [actor.userId, await encryptSecret("ghr-synthetic", ENCRYPTION_KEY)],
    );
    const githubFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token")
        return Response.json({
          access_token: "ghu-synthetic",
          refresh_token: "ghr-next",
          expires_in: 3600,
          refresh_token_expires_in: 7200,
        });
      if (url === "https://api.github.com/user") return Response.json({ id: 7, login: "builder", name: null });
      if (url.includes("/user/installations"))
        return Response.json({
          installations: [
            {
              id: 9,
              app_id: 1,
              app_slug: "armada",
              account: { login: "acme", type: "Organization" },
              repository_selection: "all",
            },
          ],
        });
      if (url === "https://api.github.com/repos/acme/web")
        return Response.json({
          id: 10,
          name: "web",
          default_branch: "main",
          owner: { login: "acme" },
          private: true,
        });
      throw new Error("Unexpected GitHub endpoint.");
    }) as typeof fetch;
    const service = createGoldenCreateService({
      sql: db,
      github: {
        store: createSqlVaultStore(db),
        encryptionKey: ENCRYPTION_KEY,
        app: { clientId: "test", clientSecret: "synthetic" },
        fetch: githubFetch,
      },
      installationApp: null,
      fetch: githubFetch,
      ssh: async () => {},
    });
    await service.create(provider, actor, {
      name: "restorable",
      repos: ["acme/web"],
      visibility: "org",
      modal: scope.binding,
    });
    const goldens = createSqlGoldenStore(db);
    const [golden] = await goldens.findByName(actor.orgId, "restorable");
    expect(golden?.providerSandboxId).toBeNull();
    const image = await store.image(golden!.providerSnapshotId!);
    const original = await store.get(image.sourceId);
    expect(original).toMatchObject({ phase: "deleted", golden: true });
    expect(machines.get(original.physicalId!)?.terminated).toBe(true);
    // This runs the real adapter port; absence or sealed-admission refusal must remain a failure.
    // Never substitute a normal fork or a fake get(stopped) to make the lifecycle test green.
    // A readable org golden is not fresh mutation authority after demotion during CAS.
    await db.query("update members set role='admin' where org_id=$1 and user_id=$2", [people.org, people.owner]);
    let demotionWinner: string | undefined;
    const demotedReadback = {
      ...goldens,
      async replaceSandbox() {
        demotionWinner = (await connectGolden(secondaryProvider, goldens, secondaryActor, "restorable")).sandbox.id;
        await db.query("update members set role='member' where org_id=$1 and user_id=$2", [people.org, actor.userId]);
        return false;
      },
    };
    await expect(connectGolden(provider, demotedReadback, actor, "restorable")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect((await goldens.findByName(actor.orgId, "restorable"))[0]?.providerSandboxId).toBe(demotionWinner);
    expect((await provider.get(demotionWinner!)).state).toBe("ready");
    await db.query("update members set role='admin' where org_id=$1 and user_id=$2", [people.org, actor.userId]);
    await snapshotGolden(provider, goldens, actor, "restorable");
    let concurrentMaster: string | undefined;
    const concurrentConnect = {
      ...goldens,
      async replaceSandbox() {
        // A second actual connect publishes the same idempotently restored source first.
        concurrentMaster = (await connectGolden(secondaryProvider, goldens, secondaryActor, "restorable")).sandbox.id;
        return false;
      },
    };
    const connected = await connectGolden(provider, concurrentConnect, actor, "restorable");
    expect(concurrentMaster).toBe(connected.sandbox.id);
    expect((await provider.get(connected.sandbox.id)).state).toBe("ready");
    let id = connected.sandbox.id;
    expect(connected.sandbox.state).toBe("ready");
    expect(await store.get(id)).toMatchObject({ phase: "active", golden: true });
    expect((await goldens.findByName(actor.orgId, "restorable"))[0]?.providerSandboxId).toBe(id);
    await provider.exec({ sandboxId: id, command: "printf revision-one > revision.txt" });
    const saved = await snapshotGolden(provider, goldens, actor, "restorable");
    const firstImage = await store.image(saved.snapshotName);
    expect(await readFile(join(imageDirectories.get(firstImage.imageId!)!, "revision.txt"), "utf8")).toBe(
      "revision-one",
    );
    expect(saved.golden.providerSandboxId).toBeNull();
    expect((await provider.getSnapshot(saved.snapshotName)).status).toBe("ready");
    expect((await goldens.findByName(actor.orgId, "restorable"))[0]?.providerSnapshotId).toBe(saved.snapshotName);
    expect((await store.get(id)).phase).toBe("stopped");
    await expect(
      connectGolden(provider, { ...goldens, replaceSandbox: async () => false }, actor, "restorable"),
    ).rejects.toThrow("Retained shared Modal master");
    expect((await provider.get(id)).state).toBe("ready");
    const physicalCount = machines.size;
    const connectedAgain = await connectGolden(provider, goldens, actor, "restorable");
    expect(machines.size).toBe(physicalCount);
    id = connectedAgain.sandbox.id;
    expect((await store.get(id)).golden).toBe(true);
    const restoredBytes = await provider.exec({ sandboxId: id, command: "cat revision.txt" });
    expect(!restoredBytes.detached && restoredBytes.stdout).toBe("revision-one");
    await provider.exec({ sandboxId: id, command: "printf revision-two > revision.txt" });
    const savedAgain = await snapshotGolden(provider, goldens, actor, "restorable");
    const secondImage = await store.image(savedAgain.snapshotName);
    expect(secondImage.imageId).not.toBe(firstImage.imageId);
    expect(await readFile(join(imageDirectories.get(secondImage.imageId!)!, "revision.txt"), "utf8")).toBe(
      "revision-two",
    );
    expect(await readFile(join(imageDirectories.get(firstImage.imageId!)!, "revision.txt"), "utf8")).toBe(
      "revision-one",
    );
    expect(savedAgain.golden).toMatchObject({
      id: golden!.id,
      provider: "modal",
      modal: scope.binding,
      orgId: actor.orgId,
      ownerId: actor.userId,
      visibility: "org",
      providerSandboxId: null,
    });
    const forked = await provider.fork({ from: savedAgain.snapshotName, noEnv: true });
    expect((await store.get(forked.id)).golden).toBe(false);
    const forkedBytes = await provider.exec({ sandboxId: forked.id, command: "cat revision.txt" });
    expect(!forkedBytes.detached && forkedBytes.stdout).toBe("revision-two");
    expect(savedAgain.snapshotName).not.toBe(saved.snapshotName);
    // The dedicated port returns a shared source. Readiness failure after another caller's
    // publication must not delete that caller's live canonical master.
    let readinessWinner: string | undefined;
    const readinessFailure = {
      ...provider,
      async restoreGoldenMaster(input: { snapshotId: string; sandboxId?: string }) {
        const shared = await provider.restoreGoldenMaster(input);
        readinessWinner = (await connectGolden(secondaryProvider, goldens, secondaryActor, "restorable")).sandbox.id;
        failNextPoll = (await store.get(shared.id)).physicalId;
        return shared;
      },
    };
    await expect(connectGolden(readinessFailure, goldens, actor, "restorable")).rejects.toThrow();
    expect((await goldens.findByName(actor.orgId, "restorable"))[0]?.providerSandboxId).toBe(readinessWinner);
    expect((await provider.get(readinessWinner!)).state).toBe("ready");
    expect(machines.get((await store.get(readinessWinner!)).physicalId!)?.terminated).toBe(false);
    let competingSnapshot: string | undefined;
    const racingStore = {
      ...goldens,
      async compareAndSetSnapshot(...args: [string, string | null, string, string]) {
        // Another full authorized save wins before this attempt's SQL publication.
        competingSnapshot = (await snapshotGolden(provider, goldens, actor, "restorable")).snapshotName;
        return goldens.compareAndSetSnapshot!(...args);
      },
    };
    await expect(snapshotGolden(provider, racingStore, actor, "restorable")).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await goldens.findByName(actor.orgId, "restorable"))[0]?.providerSnapshotId).toBe(competingSnapshot);
    expect((await goldens.findByName(actor.orgId, "restorable"))[0]?.providerSandboxId).toBeNull();
    expect((await store.get(id)).phase).toBe("stopped");
    expect((await provider.getSnapshot(saved.snapshotName)).status).toBe("ready");
    expect((await goldens.findByName(actor.orgId, "restorable"))[0]?.providerSandboxId).toBeNull();
  } finally {
    await db.close();
    await rm(files, { recursive: true, force: true });
  }
});
