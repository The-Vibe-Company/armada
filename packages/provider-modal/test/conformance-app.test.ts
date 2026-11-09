import { expect, test } from "bun:test";
import { type AppAdapter, cliAppAdapter, createOwnedApp, finalizeOwnedApp } from "./conformance-app.ts";

function fixture() {
  let rows: { id: string; name: string; state: string; tasks: number }[] = [];
  let stops = 0;
  const journal: unknown[] = [];
  const save = async (value: unknown) => {
    journal.push(structuredClone(value));
  };
  const adapter: AppAdapter = {
    list: async () => rows,
    create: async (name) => {
      rows = [{ id: "ap-new", name, state: "deployed", tasks: 0 }];
      return "ap-new";
    },
    stop: async () => {
      stops++;
      rows[0]!.state = "stopped";
    },
  };
  return {
    adapter,
    save,
    journal,
    get rows() {
      return rows;
    },
    get stops() {
      return stops;
    },
  };
}
const clean = {
  complete: true,
  resources: [{ sandboxId: "logical", phase: "deleted", registryConfirmed: true }],
  imageCount: 0,
};

test("new fixture records creation before mutation, retires with readback and is idempotent", async () => {
  const f = fixture();
  const app = await createOwnedApp(f.adapter, "test", f.save);
  expect(f.journal[0]).toMatchObject({ creation: "pending", environment: "test", finalization: "incomplete" });
  await finalizeOwnedApp(f.adapter, app, clean, f.save);
  await finalizeOwnedApp(f.adapter, app, clean, f.save);
  expect(f.stops).toBe(1);
  expect(f.journal.at(-1)).toMatchObject({ appId: "ap-new", finalization: "stopped" });
});

test("refuses borrowed identity, incomplete cleanup, retained images and uncertain registry", async () => {
  for (const change of ["borrowed", "pending", "failed", "images", "live", "uncertain", "tasks", "missing"]) {
    const f = fixture();
    const app = await createOwnedApp(f.adapter, "test", f.save);
    const proof = structuredClone(clean);
    if (change === "borrowed") app.name = "production";
    if (change === "pending") app.creation = "pending";
    if (change === "failed") proof.complete = false;
    if (change === "images") proof.imageCount = 1;
    if (change === "live") proof.resources[0]!.phase = "checkpoint";
    if (change === "uncertain") proof.resources[0]!.registryConfirmed = false;
    if (change === "tasks") f.rows[0]!.tasks = 1;
    if (change === "missing") f.rows.splice(0);
    await expect(finalizeOwnedApp(f.adapter, app, proof, f.save)).rejects.toThrow();
    expect(f.stops).toBe(0);
    expect(app.finalization).toBe("incomplete");
  }
});

test("ambiguous creation never records owned confirmation", async () => {
  const f = fixture();
  f.adapter.create = async () => {
    throw Error("lost response");
  };
  await expect(createOwnedApp(f.adapter, "test", f.save)).rejects.toThrow();
  expect(f.journal).toHaveLength(1);
  expect(f.journal[0]).toMatchObject({ creation: "pending" });
});

test("stop error and missing terminal readback remain incomplete", async () => {
  for (const fail of [true, false]) {
    const f = fixture();
    const app = await createOwnedApp(f.adapter, "test", f.save);
    f.adapter.stop = async () => {
      if (fail) throw Error("private diagnostic");
    };
    await expect(finalizeOwnedApp(f.adapter, app, clean, f.save)).rejects.toThrow();
    expect(app.finalization).toBe("incomplete");
    expect(f.journal.at(-1)).toMatchObject({ finalization: "incomplete" });
  }
});

test("CLI boundary uses exact IDs/environment, private env and fails closed on malformed output", async () => {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  let output = '[{"app_id":"ap-new","description":"fixture","state":"stopped","tasks":"0"}]';
  const adapter = cliAppAdapter(
    "private-id",
    "private-secret",
    async () => "unused",
    async (args, env) => {
      calls.push({ args, env });
      return output;
    },
  );
  expect(await adapter.list("test")).toEqual([{ id: "ap-new", name: "fixture", state: "stopped", tasks: 0 }]);
  await adapter.stop("ap-new", "test");
  expect(calls[1]?.args).toEqual(["app", "stop", "ap-new", "--env", "test", "--yes"]);
  expect(calls[1]?.env.MODAL_CONFIG_PATH).toBe("/dev/null");
  expect(calls[1]?.args.join(" ")).not.toContain("private");
  output = '[{"app_id":"ap-new"}]';
  await expect(adapter.list("test")).rejects.toThrow();
});
