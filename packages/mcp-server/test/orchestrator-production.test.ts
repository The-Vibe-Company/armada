import { expect, test } from "bun:test";
import * as core from "@armada/core/server";
import type { ModalOrchestratorCheckpoint, ModalProvider } from "@armada/provider-modal";
import type { Caller } from "../src/caller.ts";
import { createSqlData } from "../src/data.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { callOrchestrator } from "../src/orchestrator-api.ts";
import { createProductionOrchestrators } from "../src/orchestrator-production.ts";
import { orchestratorScopedMcpUrl } from "../src/orchestrator-scoped-gateway.ts";
import { preserveBeforeStop } from "../src/work-preservation.ts";
import { catalogLock, catalogReceipt, catalogReference } from "./fixtures/skillpack-catalog.ts";
import { database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

// SQL composition regression, not native conformance. Placement I/O is fake;
// authority, receipts, lifecycle, account selection and publication are actual.
test("production Modal Codex bundle owns create/message/checkpoint/resume and private epoch admission", async () => {
  const { db, people: p } = await database();
  const sql: core.Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const placement = fakeBoat();
  const revision = "a".repeat(40);
  placement.setExecOutput({
    stdout: `Source: https://github.com/The-Vibe-Company/armada/tree/${revision}/.agents/skills\n`,
  });
  let physical = "1";
  let grant: string | undefined;
  let checkpoint: ModalOrchestratorCheckpoint | undefined;
  let restores = 0;
  let nativeReads = 0;
  let fault: "none" | "launcher" | "fork" | "initialization" | "skills" | "epoch" = "none";
  let throwLogger = false;
  let stopUnconfirmed = false;
  let deletePending = false;
  const lines: string[] = [];
  const childPreparation: string[] = [];
  const privateText = "synthetic-provider-credential-do-not-log";
  const provider: core.Provider &
    Pick<ModalProvider, "checkpointOrchestrator" | "readOrchestratorCheckpoint" | "restoreOrchestratorCheckpoint"> = {
    ...placement.provider,
    id: "modal",
    get harnesses() {
      return fault === "launcher" ? (["claude"] as const) : placement.provider.harnesses;
    },
    async fork(request) {
      if (fault === "fork")
        throw new core.ProviderError({
          provider: "modal",
          code: "unavailable",
          message: privateText,
          retryable: false,
        });
      return placement.provider.fork(request);
    },
    async exec(request) {
      const result = await placement.provider.exec(request);
      if (request.command.includes("skillpack install ")) {
        childPreparation.push("install");
        return { ...result, stdout: catalogLock("codex") };
      }
      return fault === "initialization" || (fault === "skills" && request.command.includes("/skills/armada-tools"))
        ? { ...result, exitCode: 127, stdout: privateText, stderr: privateText }
        : result;
    },
    async stop(request) {
      if (stopUnconfirmed) throw new Error(privateText);
      return placement.provider.stop(request);
    },
    async delete(request) {
      if (deletePending) return { status: "pending" };
      if (stopUnconfirmed) throw new Error(privateText);
      await placement.provider.stop(request);
      return { status: "deleted" };
    },
    async prompt(request) {
      childPreparation.push("prompt");
      return placement.provider.prompt(request);
    },
    async get(id, options) {
      nativeReads++;
      return {
        ...(await placement.provider.get(id, options)),
        physicalGeneration: physical,
        expiresAt: new Date(Date.now() + 3600_000),
      };
    },
    async installOrchestratorEpoch(request) {
      if (fault === "epoch") throw Error(privateText);
      grant = request.token;
      return { acknowledged: true };
    },
    async scrubOrchestratorEpoch() {
      grant = undefined;
      return { acknowledged: true };
    },
    async quiesceOrchestrator() {
      return { acknowledged: true };
    },
    async observeOrchestrator() {
      return {
        physicalGeneration: physical,
        state: "quiescent",
        evidence: "fixture-native",
        eventWatermark: 1,
        acknowledgedSequence: 1,
        nativeSessionId: "native-thread",
      };
    },
    async verifyOrchestratorSession(request) {
      return { ...request, verified: true };
    },
    async checkpointOrchestrator(request) {
      checkpoint = {
        ...request,
        version: 1,
        nativeSessionId: "native-thread",
        eventWatermark: 1,
        acknowledgedSequence: 1,
        checkpointId: "saved-image",
        state: "stopped",
      };
      await placement.provider.stop({ sandboxId: request.sandboxId });
      return checkpoint;
    },
    async readOrchestratorCheckpoint() {
      return checkpoint ?? null;
    },
    async restoreOrchestratorCheckpoint(request) {
      restores++;
      physical = "2";
      placement.sandbox(request.sandboxId).info.state = "ready";
      return {
        physicalGeneration: physical,
        conversationId: request.checkpoint.conversationId!,
        nativeSessionId: request.checkpoint.nativeSessionId!,
        verified: true,
      };
    },
  };
  const input = {
    sql,
    providers: { resolve: async () => provider },
    credentials: launchCredentials(core.createSqlVaultStore(sql), ENCRYPTION_KEY),
    connections: undefined,
    encryptionKey: ENCRYPTION_KEY,
    scopedMcpUrl: orchestratorScopedMcpUrl("https://armada.invalid"),
    skillRevision: revision,
    diagnosticLog: (line: string) => {
      lines.push(line);
      if (throwLogger) throw Error(privateText);
    },
  };
  let bundle: ReturnType<typeof createProductionOrchestrators>;
  try {
    expect(createProductionOrchestrators({ ...input, requestedPairs: [] })).toBeUndefined();
    const golden = await core.createSqlGoldenStore(sql).insert({
      orgId: p.org,
      ownerId: p.owner,
      name: "composed-modal",
      visibility: "org",
      provider: "modal",
      modal: { workspace: "fixture", environment: "test", appId: "ap_fixture" },
      config: { repos: [{ url: "https://github.com/example/project.git", branch: "main", dir: "project" }], init: [] },
    });
    await core.createSqlGoldenStore(sql).setSnapshot(golden.id, "modal-image");
    // An explicit golden ID must survive the ordinary launcher's same-name policy.
    const shadow = await core.createSqlGoldenStore(sql).insert({
      orgId: p.org,
      ownerId: p.owner,
      name: "composed-modal",
      visibility: "private",
      provider: "modal",
      modal: { workspace: "fixture", environment: "test", appId: "ap_fixture" },
      config: { repos: [{ url: "https://github.com/example/shadow.git", branch: "main", dir: "shadow" }], init: [] },
    });
    await core.createSqlGoldenStore(sql).setSnapshot(shadow.id, "wrong-image");
    const account = (
      await sql.query<{ id: string; version: number }>(
        "select id,version from credentials where scope='org' and owner_id=$1 and kind='openai'",
        [p.org],
      )
    ).rows[0];
    if (!account) throw Error("fixture account missing");
    bundle = createProductionOrchestrators({ ...input, requestedPairs: ["modal:codex"] });
    if (!bundle) throw Error("production bundle missing");
    const caller: Caller = { userId: p.owner, orgs: [{ orgId: p.org, role: "member" }], via: "supabase" };
    const capabilities = await callOrchestrator(bundle.runtime, caller, "capabilities", {}, undefined, ["modal:codex"]);
    expect(capabilities).toMatchObject({
      enabled: true,
      pairs: [
        { provider: "boat", enabled: false, reason: "server_setting_off" },
        { provider: "boat", enabled: false, reason: "server_setting_off" },
        { provider: "modal", harness: "claude", enabled: false, reason: "native_resume_driver_unavailable" },
        { provider: "modal", harness: "codex", enabled: true, reason: null },
      ],
    });
    const config: core.OrchestratorCreate = {
      version: 1,
      orgId: p.org,
      name: "production-composed",
      goldenId: golden.id,
      provider: "modal",
      harness: "codex",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      modelAccountId: account.id,
    };
    const settleCreate = async (configuration: core.OrchestratorCreate, key: string) => {
      const admitted = await bundle!.runtime.create(caller, configuration, key);
      await bundle!.runtime.createWorker.drain();
      const result = (await bundle!.store.operations(p.owner, p.org, admitted.orchestratorId)).find(
        (operation) => operation.id === admitted.id,
      );
      if (!result) throw Error("Create receipt missing after worker drain.");
      return result;
    };
    expect(
      (await settleCreate({ ...config, harness: "claude", model: "claude-opus-5-5" }, "unsupported-claude")).state,
    ).toBe("failed");
    expect(placement.forks).toHaveLength(0);
    const created = await settleCreate(config, "production-create");
    expect(created.state).toBe("succeeded");
    expect(grant).toMatch(/^armada_epoch_[a-f0-9]{64}$/);
    const id = created.orchestratorId;
    const delegation = (
      await sql.query<{
        golden_ids: string[];
        account_ids: string[];
        native_generation: string;
        acknowledged_at: string | null;
      }>(
        "select golden_ids,account_ids,native_generation,acknowledged_at from orchestrator_delegations where orchestrator_id=$1",
        [id],
      )
    ).rows[0];
    expect(delegation).toMatchObject({ golden_ids: [golden.id], account_ids: [account.id], native_generation: "1" });
    expect(delegation?.acknowledged_at).not.toBeNull();
    const sent = await bundle.runtime.mutate(caller, {
      orgId: p.org,
      id,
      action: "message",
      key: "production-message",
      expectedRevision: created.revision,
      text: "hello",
    });
    expect(sent.state).toBe("succeeded");
    const steered = await bundle.runtime.mutate(caller, {
      orgId: p.org,
      id,
      action: "steer",
      key: "production-steer",
      expectedRevision: sent.revision,
      text: "keep it short",
    });
    expect(steered.state).toBe("succeeded");
    placement.finish("bx_1", "prompt_1", "finished");
    const stopped = await bundle.runtime.mutate(caller, {
      orgId: p.org,
      id,
      action: "stop",
      key: "production-stop",
      expectedRevision: steered.revision,
    });
    expect(stopped.state).toBe("succeeded");
    expect(grant).toBeUndefined();
    expect((await bundle.runtime.detail(caller, p.org, id)).orchestrator).toMatchObject({
      state: "stopped",
      continuity: "native",
    });
    const resumed = await bundle.runtime.mutate(caller, {
      orgId: p.org,
      id,
      action: "resume",
      key: "production-resume",
      expectedRevision: stopped.revision,
    });
    expect(resumed.state).toBe("succeeded");
    expect(restores).toBe(1);
    expect(placement.prompts).toHaveLength(1); // Resume must not manufacture inference.
    expect(grant).toMatch(/^armada_epoch_[a-f0-9]{64}$/);
    expect((await bundle.runtime.detail(caller, p.org, id)).orchestrator).toMatchObject({
      state: "ready",
      conversationId: "conv_1",
      continuity: "native",
    });
    const scoped = async (action: string, body: unknown, key = "production-child-read") =>
      bundle?.scopedToolsRoute(
        new Request(`https://armada.invalid/api/v1/orchestrator-tools/${action}`, {
          method: "POST",
          headers: { authorization: `Bearer ${grant}`, "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify(body),
        }),
      );
    childPreparation.length = 0;
    const childSelection = {
      goldenId: golden.id,
      harness: "codex",
      credentialId: account.id,
      credentialVersion: account.version,
      model: "gpt-6.1-sol",
      skills: [catalogReference],
    };
    const childResponse = await scoped("launch", { selection: childSelection }, "production-child");
    expect(childResponse?.status).toBe(200);
    const childReceipt = (await childResponse?.json()) as { result: { state: string; sandboxId: string } };
    expect(childReceipt.result.state).toBe("succeeded");
    expect(childPreparation).toEqual(["install"]);
    expect(
      (
        await sql.query<{ skills: unknown; conversation_ids: string[] }>(
          "select skills,conversation_ids from public.sandboxes where id=$1",
          [childReceipt.result.sandboxId],
        )
      ).rows[0],
    ).toEqual({ skills: [catalogReceipt], conversation_ids: [] });
    const unrelatedStore = createSqlData(sql)({ ...caller, userId: p.admin }).sandboxes;
    await expect(unrelatedStore.recordSkills!(childReceipt.result.sandboxId, [])).rejects.toThrow(
      "Skill receipts could not be recorded.",
    );
    const replayedChild = await scoped("launch", { selection: childSelection }, "production-child");
    expect(await replayedChild?.json()).toEqual({ result: childReceipt.result });
    const conflictingSkills = await scoped(
      "launch",
      {
        selection: { ...childSelection, skills: ["example/other@1.0.0"] },
      },
      "production-child",
    );
    expect(conflictingSkills?.status).toBe(503);
    expect(await conflictingSkills?.json()).toEqual({
      error: {
        code: "scoped_operation_unavailable",
        message: "scoped_operation_unavailable",
      },
    });
    expect(childPreparation).toEqual(["install"]);

    expect(
      (await sql.query("select sandbox_id from orchestrator_children where orchestrator_id=$1", [id])).rows,
    ).toEqual([{ sandbox_id: childReceipt.result.sandboxId }]);
    expect(placement.forks.map((fork) => fork.from)).toEqual(["modal-image", "modal-image"]);
    // A prior successful stop epoch must not cover newly admitted child work.
    await sql.query("update sandboxes set stop_requested_at=clock_timestamp(),stop_generation=1 where id=$1", [
      childReceipt.result.sandboxId,
    ]);
    placement.setExecOutput({ stdout: '{"status":"clean"}' });
    await preserveBeforeStop(
      sql,
      provider,
      childReceipt.result.sandboxId,
      (
        await sql.query<{ provider_sandbox_id: string }>("select provider_sandbox_id from sandboxes where id=$1", [
          childReceipt.result.sandboxId,
        ])
      ).rows[0]!.provider_sandbox_id,
      "managed_child_stop",
    );
    const capturesBeforeMessage = placement.execs.filter((r) => r.preservationStage === "collect_exec").length;
    placement.setExecOutput({
      stdout: `Source: https://github.com/The-Vibe-Company/armada/tree/${revision}/.agents/skills\n`,
    });
    // The original smoke's "exact" payload omitted sandboxId. The real server
    // rejects that shape before dispatch; the corrected instruction must bind it.
    const missingTarget = await scoped("message", { text: "child hello" }, "missing-child-target");
    expect(missingTarget?.status).toBe(400);
    const messagedChild = await scoped(
      "message",
      { sandboxId: childReceipt.result.sandboxId, text: "child hello" },
      "production-child-message",
    );
    expect(await messagedChild?.json()).toMatchObject({ result: { state: "succeeded" } });
    const priorQuiesce = provider.quiesce;
    const priorStops = placement.stops.length;
    provider.quiesce = async () => {
      throw new core.ProviderError({
        provider: "modal",
        code: "sandbox_not_ready",
        retryable: true,
        message: "Interruption pending",
      });
    };
    const pendingStop = await scoped(
      "stop",
      { sandboxId: childReceipt.result.sandboxId },
      "production-child-stop-pending",
    );
    expect(await pendingStop?.json()).toMatchObject({ result: { state: "uncertain" } });
    expect(placement.stops).toHaveLength(priorStops);
    if (priorQuiesce) provider.quiesce = priorQuiesce;
    else delete provider.quiesce;
    expect(
      (
        await sql.query("select requested_model from sandbox_turn_models where sandbox_id=$1", [
          childReceipt.result.sandboxId,
        ])
      ).rows,
    ).toEqual([{ requested_model: "gpt-6.1-sol" }]);
    const stoppedChild = await scoped("stop", { sandboxId: childReceipt.result.sandboxId }, "production-child-stop");
    expect(await stoppedChild?.json()).toMatchObject({ result: { state: "succeeded" } });
    expect(placement.execs.filter((r) => r.preservationStage === "collect_exec")).toHaveLength(
      capturesBeforeMessage + 1,
    );
    const childRead = await scoped("read", { sandboxId: childReceipt.result.sandboxId });
    expect(await childRead?.json()).toMatchObject({
      result: { status: "stopped", ownerId: p.owner, credentialId: account.id },
    });
    const denied = await bundle.scopedToolsRoute(
      new Request("https://armada.invalid/api/v1/orchestrator-tools/wait_record", {
        method: "POST",
        headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(denied?.status).toBe(503);
    expect(await denied?.json()).toEqual({
      error: { code: "admit_wait_not_supported", message: "admit_wait_not_supported" },
    });
    const stoppedAgain = await bundle.runtime.mutate(caller, {
      orgId: p.org,
      id,
      action: "stop",
      key: "production-stop-again",
      expectedRevision: resumed.revision,
    });
    expect(stoppedAgain.state).toBe("succeeded");
    expect(checkpoint?.physicalGeneration).toBe("2");
    expect(grant).toBeUndefined();
    const readsBeforeHistory = nativeReads;
    expect((await bundle.runtime.events(caller, p.org, id)).events.some((event) => event.kind === "agent")).toBe(true);
    expect((await bundle.runtime.detail(caller, p.org, id)).orchestrator).toMatchObject({
      state: "stopped",
      continuity: "native",
    });
    expect(nativeReads).toBe(readsBeforeHistory);
    lines.length = 0;
    await expect(
      bundle.runtime.mutate(caller, {
        orgId: p.org,
        id,
        action: "message",
        key: "private-message-key",
        expectedRevision: stoppedAgain.revision,
        text: privateText,
      }),
    ).rejects.toMatchObject({ code: "conflict", admission: "not_admitted" });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        action: "message",
        outcome: "error",
        stage: "request_lookup",
        reason: "runtime_conflict",
        orchestratorId: id,
      }),
    ]);
    expect(lines.join("\n")).not.toContain(privateText);
    expect(lines.join("\n")).not.toContain("private-message-key");
    // Real SQL assembly, synthetic faults: diagnostics cannot change the original
    // receipt, publication fence, retry behavior, or expose upstream diagnostics.
    for (const scenario of [
      "launcher",
      "fork",
      "registration",
      "initialization",
      "skills",
      "private-skill",
      "private-skill-stop-unconfirmed",
      "private-skill-delete-pending",
      "expired-skill-key",
      "undecryptable-skill-key",
      "epoch",
      "completion",
      "failure_publication",
    ] as const) {
      lines.length = 0;
      stopUnconfirmed = scenario === "private-skill-stop-unconfirmed";
      deletePending = scenario === "private-skill-delete-pending";
      const privateSkill = scenario === "private-skill" || stopUnconfirmed || deletePending;
      fault = ["launcher", "fork", "initialization", "skills", "epoch"].includes(scenario)
        ? (scenario as typeof fault)
        : "none";
      throwLogger = scenario === "fork";
      if (scenario === "registration")
        await db.exec(`create function diagnostic_registration_fault() returns trigger language plpgsql as $$ begin raise exception using errcode='23514',message='synthetic-private-sql'; end $$;
        create trigger diagnostic_registration_fault before insert on sandboxes for each row execute function diagnostic_registration_fault()`);
      if (scenario === "completion" || scenario === "failure_publication")
        await db.exec(`create function diagnostic_publication_fault() returns trigger language plpgsql as $$ begin
        if new.state='succeeded' or (new.state='uncertain' and ${scenario === "failure_publication" ? "true" : "false"}) then raise exception using errcode='40001',message='synthetic-private-sql'; end if; return new; end $$;
        create trigger diagnostic_publication_fault before update on orchestrator_operations for each row execute function diagnostic_publication_fault()`);
      const storedSkillKey = scenario === "expired-skill-key" || scenario === "undecryptable-skill-key";
      if (storedSkillKey) {
        const orgKey = await core.encryptSecret("cmp_pat_" + "b".repeat(48), ENCRYPTION_KEY);
        await sql.query(
          "insert into public.credentials(scope,owner_id,kind,value_enc) values('org',$1,'skillpack',$2::bytea)",
          [p.org, orgKey],
        );
        await sql.query(
          "insert into public.credentials(scope,owner_id,kind,value_enc,expires_at) values('user',$1,'skillpack',$2::bytea,$3::timestamptz)",
          [
            p.owner,
            scenario === "expired-skill-key" ? orgKey : new Uint8Array([1, 2, 3]),
            scenario === "expired-skill-key" ? "2000-01-01T00:00:00Z" : null,
          ],
        );
      }
      const admitted = await bundle.runtime.create(
        caller,
        {
          ...config,
          name: `diagnostic-${scenario}`,
          ...(privateSkill || storedSkillKey ? { skill: "notes@1.0.0" } : {}),
        },
        `diagnostic-${scenario}`,
      );
      expect(admitted.state).toBe("pending");
      await bundle.runtime.createWorker.drain();
      const operation = (await bundle.store.operations(p.owner, p.org, admitted.orchestratorId)).find(
        (item) => item.id === admitted.id,
      );
      expect(operation?.state).toBe(
        scenario === "launcher" || privateSkill || storedSkillKey
          ? "failed"
          : scenario === "failure_publication"
            ? "pending"
            : "uncertain",
      );
      if (storedSkillKey || privateSkill) {
        const failedParent = (await bundle.runtime.detail(caller, p.org, admitted.orchestratorId)).orchestrator;
        expect(failedParent.state).toBe(stopUnconfirmed || deletePending ? "blocked" : "stopped");
        expect(failedParent.conversationId).toBeNull();
        expect(failedParent.skillReceipt).toBeNull();
        await expect(
          bundle.runtime.mutate(caller, {
            orgId: p.org,
            id: failedParent.id,
            action: "resume",
            key: `resume-failed-${scenario}`,
            expectedRevision: failedParent.revision,
          }),
        ).rejects.toMatchObject({ code: "conflict" });
        const sandbox = (
          await sql.query<{ status: string; stopped_at: unknown }>(
            "select status,stopped_at from public.sandboxes where id=$1",
            [failedParent.sandboxId],
          )
        ).rows[0];
        if (!stopUnconfirmed && !deletePending) {
          expect(sandbox?.status).toBe("deleted");
          expect(sandbox?.stopped_at).not.toBeNull();
        } else {
          expect(sandbox?.status).not.toBe("deleted");
          expect(sandbox?.stopped_at).toBeNull();
        }
      }
      if (storedSkillKey) {
        const expectedReason =
          scenario === "expired-skill-key" ? "skillpack_credential_refused" : "skillpack_credential_unreadable";
        expect(operation?.errorCode).toBe(expectedReason);
        expect((await bundle.runtime.detail(caller, p.org, admitted.orchestratorId)).orchestrator.blockedReason).toBe(
          expectedReason,
        );
        await sql.query("delete from public.credentials where kind='skillpack' and owner_id in ($1,$2)", [
          p.owner,
          p.org,
        ]);
      }
      if (privateSkill) {
        expect(operation?.errorCode).toBe("skillpack_credential_missing");
        expect((await bundle.runtime.detail(caller, p.org, admitted.orchestratorId)).orchestrator.blockedReason).toBe(
          "skillpack_credential_missing",
        );
      }
      if (scenario === "registration")
        await db.exec(
          "drop trigger diagnostic_registration_fault on sandboxes; drop function diagnostic_registration_fault()",
        );
      if (scenario === "completion" || scenario === "failure_publication")
        await db.exec(
          "drop trigger diagnostic_publication_fault on orchestrator_operations; drop function diagnostic_publication_fault()",
        );
      const records = lines.map((line) => JSON.parse(line));
      const expected = {
        launcher: ["launcher_configuration", "launcher_invalid_request"],
        fork: ["fork", "provider_unavailable"],
        registration: ["registration", "sql_check"],
        initialization: ["initialization_repository", "launcher_init_failed"],
        skills: ["skills", "skill_command_missing"],
        "private-skill": ["skills_credential", "skillpack_credential_missing"],
        "private-skill-stop-unconfirmed": ["skills_credential", "skillpack_credential_missing"],
        "private-skill-delete-pending": ["skills_credential", "skillpack_credential_missing"],
        "expired-skill-key": ["skills_credential", "skillpack_credential_refused"],
        "undecryptable-skill-key": ["skills_credential", "skillpack_credential_unreadable"],
        epoch: ["epoch_install", "authority_denied"],
        completion: ["completion", "sql_serialization"],
        failure_publication: ["completion", "sql_serialization"],
      }[scenario];
      expect(records[0]).toMatchObject({
        component: "owner",
        action: "create",
        outcome: scenario === "launcher" || privateSkill || storedSkillKey ? "failed" : "uncertain",
        stage: expected[0],
        reason: expected[1],
      });
      const cleanupRecords = records.filter((record) => record.event === "orchestrator_create_cleanup_failure");
      if (stopUnconfirmed || deletePending) {
        expect(cleanupRecords).toHaveLength(1);
        expect(cleanupRecords[0]).toMatchObject({
          action: "create",
          outcome: "unconfirmed",
          step: deletePending ? "unconfirmed" : "delete",
          reason: deletePending ? "cleanup_unconfirmed" : "unexpected_error",
        });
      } else expect(cleanupRecords).toHaveLength(0);
      expect(records[0].operationId).toMatch(/^[a-f0-9-]{36}$/);
      expect(records[0].orchestratorId).toMatch(/^[a-f0-9-]{36}$/);
      if (scenario === "failure_publication")
        expect(records[1]).toMatchObject({
          outcome: "publication_failed",
          stage: "failure_publication",
          failureStage: expected[0],
          failureReason: expected[1],
        });
      expect(lines.join("\n")).not.toContain(privateText);
      expect(lines.join("\n")).not.toContain("synthetic-private-sql");
      expect(lines.join("\n")).not.toContain("diagnostic-");
      expect(lines.join("\n")).not.toContain("armada_epoch_");
      if (scenario === "fork") {
        lines.length = 0;
        const forks = placement.forks.length;
        const replay = await bundle.runtime.create(
          caller,
          { ...config, name: `diagnostic-${scenario}` },
          `diagnostic-${scenario}`,
        );
        expect(replay.state).toBe("uncertain");
        expect(placement.forks).toHaveLength(forks);
        expect(lines.map((line) => JSON.parse(line))).toEqual([
          {
            event: "orchestrator_operation_failure",
            component: "owner",
            action: "create",
            outcome: "uncertain",
            stage: "request_lookup",
            reason: "recorded_operation_uncertain",
            operationId: replay.id,
            orchestratorId: replay.orchestratorId,
          },
        ]);
      }
    }
    fault = "none";
    throwLogger = false;
    lines.length = 0;
    await sql.query("delete from members where org_id=$1 and user_id=$2", [p.org, p.owner]);
    await expect(
      bundle.runtime.create(caller, { ...config, name: "untrusted-name" }, "untrusted-key"),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        event: "orchestrator_operation_failure",
        component: "owner",
        action: "create",
        outcome: "error",
        stage: "request_lookup",
        reason: "runtime_not_found",
      },
    ]);
  } finally {
    await bundle?.runtime.createWorker.drain();
    await bundle?.lifecycleWorker.drain();
    await bundle?.childWorker.drain();
    await db.close();
  }
});
