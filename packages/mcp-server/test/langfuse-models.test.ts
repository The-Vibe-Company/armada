import { expect, spyOn, test } from "bun:test";
import * as lf from "../src/langfuse-models.ts";

const cfg: lf.LangfuseConfig = { host: "https://langfuse.test", publicKey: "pk_ph", secretKey: "sk_ph" };
const auth = `Basic ${Buffer.from("pk_ph:sk_ph").toString("base64")}`;
const mk = (fn: (url: string, init?: RequestInit) => Promise<Response>) =>
  Object.assign((u: Parameters<typeof fetch>[0], i?: RequestInit) => fn(String(u), i), {
    preconnect: fetch.preconnect,
  });
type P = lf.LangfuseTokenPricesPerMillion;
const px = (i: number, o: number, cr: number | null = null, cw: number | null = null, r: number | null = null) =>
  ({ input: i, output: o, cacheRead: cr, cacheWrite: cw, reasoning: r }) satisfies P;
const rec = (id: string, m: string, p: string, mg = true, pp = px(2, 10, 0.1)) => {
  const r = { id, modelName: m, matchPattern: p, unit: "TOKENS", isLangfuseManaged: mg, pricesPerMillion: pp };
  return r satisfies lf.LangfuseModelRecord;
};
const raw = (id: string, m: string, p: string, mg: boolean, x: Record<string, unknown>) =>
  Object.assign({ id, modelName: m, matchPattern: p, unit: "TOKENS", isLangfuseManaged: mg }, x);
const sug = (p: P, source: "langfuse" | "catalog", sourceModel: string) => ({ ...p, source, sourceModel });

test("pattern matching and known Armada model detection", () => {
  expect([
    lf.matchesLangfusePattern("(?i)^gemini-4-neon$", "GEMINI-4-NEON"),
    lf.matchesLangfusePattern("(?i)^(armada/)?morph-dsv41flash(-1017)?$", "armada/morph-dsv41flash-1017"),
    lf.matchesLangfusePattern("^gemini-4-neon$", "GEMINI-4-NEON"),
    lf.matchesLangfusePattern("", "gemini-4-neon"),
    lf.matchesLangfusePattern("(?i)", "gemini-4-neon"),
    lf.matchesLangfusePattern("(?i)[invalid", "gemini-4-neon"),
  ]).toEqual([true, true, false, false, false, false]);
  const ids =
    "gemini-4-neon,GEMINI-4-ARGON,armada/morph-dsv41flash,morph-dsv41flash-1017,armada/morph-kimik31,default,claude-opus-5-5";
  expect(ids.split(",").map(lf.isKnownLangfuseArmadaModel)).toEqual([true, true, true, true, true, false, false]);
});

test("fetchLangfuseModels paginates (max 10), parses tiers/flat formats, and maps errors safely", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const spy = spyOn(AbortSignal, "timeout");
  const tp = {
    input: 2.8e-7,
    output: 4.2e-7,
    cache_read_input_tokens: 2.8e-8,
    cache_creation_input_tokens: 3e-7,
    reasoning: 5e-7,
  };
  const t1 = { name: "L", isDefault: false, priority: 1, prices: { input: 9e-6, output: 1.8e-5 } };
  const p1 = [
    raw("t", "deepseek-chat", "(?i)^deepseek-chat$", true, {
      pricingTiers: [t1, { name: "S", isDefault: true, priority: 0, prices: tp }],
    }),
    raw("p0", "p0", "^p0$", false, { pricingTiers: [{ name: "B", priority: 0, prices: { input: 0, output: 1e-6 } }] }),
  ];
  const p2 = [
    raw("f", "kimi-k3.1-pro", "(?i)^kimi-k3\\.1-pro$", true, {
      prices: { input: 1.5e-6, output: 7.5e-6, cache_read_input_tokens: 1.5e-7 },
    }),
    raw("l", "legacy", "^legacy$", false, { unit: null, inputPrice: 3e-6, outputPrice: 1.5e-5 }),
  ];
  try {
    const paged = mk(async (url, init) => {
      calls.push({ url, init });
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json({ data: page === 1 ? p1 : p2, meta: { page, limit: 100, totalPages: 2 } });
    });
    const models = await lf.fetchLangfuseModels(paged, cfg, new AbortController().signal);
    expect(spy).toHaveBeenCalledWith(5000);
    expect(calls.map((c) => c.url)).toEqual(
      [1, 2].map((n) => `https://langfuse.test/api/public/models?limit=100&page=${n}`),
    );
    expect(calls[0]?.init).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: auth } });
    expect(models.map((m) => [m.id, m.pricesPerMillion])).toEqual([
      ["t", px(0.28, 0.42, 0.028, 0.3, 0.5)],
      ["p0", px(0, 1)],
      ["f", px(1.5, 7.5, 0.15)],
      ["l", px(3, 15)],
    ]);
  } finally {
    spy.mockRestore();
  }
  let pages = 0;
  const many = mk(async () => {
    const data = [raw(`p-${++pages}`, `m-${pages}`, "^x$", true, { inputPrice: 1e-6, outputPrice: 2e-6 })];
    return Response.json({ data, meta: { page: pages, limit: 100, totalPages: 25 } });
  });
  await lf.fetchLangfuseModels(many, cfg);
  expect(pages).toBe(10);
  for (const status of [401, 403]) {
    const deny = mk(async () => new Response("secret_body", { status }));
    const err = (await lf.fetchLangfuseModels(deny, cfg).catch((e: unknown) => e)) as lf.LangfuseModelsError;
    const out = [err instanceof lf.LangfuseModelsError, err.code, err.message.includes("secret_body")];
    expect(out).toEqual([true, "rejected", false]);
  }
  const abortSend = mk(async (_u, i) => {
    i?.signal?.throwIfAborted();
    return new Response("upstream", { status: 500 });
  });
  const sig = AbortSignal.abort(new DOMException("t", "TimeoutError"));
  await expect(lf.fetchLangfuseModels(abortSend, cfg, sig)).rejects.toMatchObject({ code: "unreachable" });
});

test("summarizeLangfuseModels handles precedence, all-sample match, Langfuse-first + catalog, and generic Morph", () => {
  const biN = rec("bi-n", "gemini-4-neon", "(?i)^gemini-4-neon$", true, px(2.5, 12, 0.2));
  const cuN = rec("cu-n", "armada:gemini-4-neon", "(?i)^gemini-4-neon$", false, px(3, 15, 0.3, 3, 15));
  const biH = rec("bi-h", "gemini-4-hydrogen", "(?i)^gemini-4-hydrogen$", true);
  const part = rec("cu-p", "partial", "(?i)^morph-dsv41flash$", false);
  const biD = rec("bi-d", "deepseek-chat", "(?i)^deepseek-chat$", true, px(0.28, 0.42, 0.028));
  expect(lf.findMatchingLangfuseModel("gemini-4-neon", [biN, cuN])?.id).toBe("cu-n");
  const morphs = ["morph-kimik31", "morph-dsv41flash", "morph-dsv41flash-1017", "morph-future.v2", "toString"];
  const sum = lf.summarizeLangfuseModels([biN, cuN, biH, part, biD], morphs);
  expect(sum.customModels.map((m) => m.id)).toEqual(["cu-n", "cu-p"]);
  const m = new Map(sum.armadaModels.map((x) => [x.id, x]));
  const st = ["gemini-4-neon", "gemini-4-hydrogen", "morph-dsv41flash", "morph-kimik31"];
  expect(st.map((id) => [m.get(id)?.status, m.get(id)?.matchedModel?.id ?? null])).toEqual([
    ["matched_custom", "cu-n"],
    ["matched_builtin", "bi-h"],
    ["unmatched", null],
    ["unmatched", null],
  ]);
  const p = (id: string) => m.get(id)?.suggestedPricesPerMillion;
  expect(p("gemini-4-neon")).toEqual(sug(px(2.5, 12, 0.2, 2.5, 12), "langfuse", "gemini-4-neon"));
  expect(p("gemini-4-hydrogen")).toEqual(sug(px(2, 10, 0.1, 2, 10), "langfuse", "gemini-4-hydrogen"));
  expect(p("morph-dsv41flash")).toEqual(sug(px(0.28, 0.42, 0.028, 0.28, 0.42), "langfuse", "deepseek-chat"));
  expect(p("morph-kimik31")).toEqual(sug(px(2, 10, 0.2, 2, 10), "catalog", "moonshotai/kimi-k3.1-pro"));
  expect(m.get("morph-future.v2")).toMatchObject({
    defaultMatchPattern: "(?i)^(armada/)?morph-future\\.v2$",
    suggestedPricesPerMillion: null,
  });
  const e = new Map(lf.summarizeLangfuseModels([]).armadaModels.map((x) => [x.id, x]));
  const s = (id: string) => e.get(id)?.suggestedPricesPerMillion;
  expect(s("gemini-4-neon")).toEqual(sug(px(2, 10, 0.1, 2, 10), "catalog", "google/gemini-4-argon"));
  expect(s("morph-dsv41flash")).toEqual(sug(px(0.15, 0.6, 0.003, 0.15, 0.6), "catalog", "deepseek-flash"));
});

test("upsertLangfuseModel converts prices, replaces POST-before-DELETE, and rejects invalid input", async () => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let delStatus = 204;
  const send = mk(async (url, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, body });
    if (method !== "POST") return new Response(null, { status: delStatus });
    return Response.json(raw("new-id", body.modelName, body.matchPattern, false, { pricingTiers: body.pricingTiers }));
  });
  const pat = "(?i)^(armada/)?morph-dsv41flash(-1017)?$";
  const pricesPerMillion = px(0.15, 0.6, 0.003, null, 0.6);
  const inp = { modelName: "armada:morph-dsv41flash", matchPattern: pat, pricesPerMillion, replaceModelId: "old/id" };
  const created = await lf.upsertLangfuseModel(send, cfg, inp);
  const expPrices = { input: 1.5e-7, output: 6e-7, cache_read_input_tokens: 3e-9, reasoning: 6e-7 };
  const tier = { name: "Standard", isDefault: true, priority: 0, conditions: [], prices: expPrices };
  const body = { modelName: inp.modelName, matchPattern: pat, unit: "TOKENS", pricingTiers: [tier] };
  expect(calls).toEqual([
    { method: "POST", url: "https://langfuse.test/api/public/models", body },
    { method: "DELETE", url: "https://langfuse.test/api/public/models/old%2Fid", body: null },
  ]);
  expect(created.pricesPerMillion).toEqual(px(0.15, 0.6, 0.003, null, 0.6));
  delStatus = 500;
  expect((await lf.upsertLangfuseModel(send, cfg, inp)).id).toBe("new-id");
  const methods: string[] = [];
  const failPost = mk(async (_u, i) => {
    methods.push(i?.method ?? "GET");
    return new Response("bad", { status: 500 });
  });
  await expect(lf.upsertLangfuseModel(failPost, cfg, inp)).rejects.toMatchObject({ code: "unreachable" });
  expect(methods).toEqual(["POST"]);
  const p0 = { input: 1, output: 2 };
  const bad: [string, string, lf.LangfuseModelOverrideInput["pricesPerMillion"]][] = [
    ["  ", "^a$", p0],
    ["a".repeat(121), "^a$", p0],
    ["ok", "(?i)[broken", p0],
    ["ok", "a".repeat(301), p0],
    ["ok", "^a$", { input: -1, output: 2 }],
    ["ok", "^a$", { input: 1, output: Number.POSITIVE_INFINITY }],
    ["ok", "^a$", { input: 100_001, output: 2 }],
    ["ok", "^a$", { ...p0, cacheRead: -0.1 }],
  ];
  for (const [m, p, pxIn] of bad) {
    const req = lf.upsertLangfuseModel(send, cfg, { modelName: m, matchPattern: p, pricesPerMillion: pxIn });
    await expect(req).rejects.toMatchObject({ code: "invalid_input" });
  }
  const bigRep = { modelName: "ok", matchPattern: "^a$", pricesPerMillion: p0, replaceModelId: "r".repeat(201) };
  await expect(lf.upsertLangfuseModel(failPost, cfg, bigRep)).rejects.toMatchObject({ code: "invalid_input" });
  expect(methods).toEqual(["POST"]);
  await expect(lf.deleteLangfuseModel(send, cfg, "  ")).rejects.toMatchObject({ code: "invalid_input" });
  const deny = mk(async () => new Response("no", { status: 403 }));
  await expect(lf.deleteLangfuseModel(deny, cfg, "m1")).rejects.toMatchObject({ code: "rejected" });
});

test("syncMissingLangfuseModels is idempotent, respects onlyModels, and preserves custom overrides", async () => {
  const stored: Record<string, unknown>[] = [
    raw("cu-neon", "my-neon", "(?i)^gemini-4-neon$", false, { prices: { input: 9e-6, output: 1.8e-5 } }),
    raw("bi-hydro", "gemini-4-hydrogen", "(?i)^gemini-4-hydrogen$", true, {
      prices: { input: 1.5e-6, output: 7.5e-6 },
    }),
  ];
  let nextId = 1;
  let failName: string | null = null;
  const send = mk(async (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return Response.json({ data: stored, meta: { page: 1, limit: 100, totalPages: 1 } });
    if (method !== "POST") return new Response(`unexpected ${method} ${url}`, { status: 400 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.modelName === failName) return new Response("boom", { status: 500 });
    const created = { id: `created-${nextId++}`, isLangfuseManaged: false, ...body };
    stored.push(created);
    return Response.json(created);
  });
  const only = { onlyModels: ["armada/morph-dsv41flash", "gemini-4-neon"] };
  const f = await lf.syncMissingLangfuseModels(send, cfg, undefined, only);
  expect([f.created, f.skipped, f.failed]).toEqual([["morph-dsv41flash"], ["gemini-4-neon"], []]);
  failName = "armada:gemini-4-carbon";
  const p = await lf.syncMissingLangfuseModels(send, cfg);
  expect([p.created, p.skipped, p.failed]).toEqual([
    ["gemini-4-argon", "morph-kimik31"],
    ["gemini-4-neon", "gemini-4-hydrogen", "morph-dsv41flash"],
    ["gemini-4-carbon"],
  ]);
  failName = null;
  expect((await lf.syncMissingLangfuseModels(send, cfg)).created).toEqual(["gemini-4-carbon"]);
  const st = await lf.syncMissingLangfuseModels(send, cfg);
  expect([st.created, st.failed, st.skipped.length]).toEqual([[], [], 6]);
  expect(stored.find((m) => m.id === "cu-neon")).toMatchObject({
    modelName: "my-neon",
    prices: { input: 9e-6, output: 1.8e-5 },
  });
});
