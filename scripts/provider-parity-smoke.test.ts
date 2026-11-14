import { expect, test } from "bun:test";
import { postDeploySmoke } from "./post-deploy-smoke.ts";
import { smokeReceipts } from "./smoke-sandbox-cleanup.ts";

const boatNotice = "boat: not part of the release gate";
const boatNotRun = { status: "not-run", reason: "not_part_of_release_gate" };

// The CLI boundary owns parity reporting: independent fake HTTP receipts catch
// route/receipt regressions without provider compute, credentials, or sleeps.
for (const mode of [
  "online",
  "idle_wake",
  "idle_pause",
  "idle_wrong_reason",
  "idle_expiry",
  "idle_conversation",
  "idle_recall",
  "idle_budget",
  "snapshot_valid",
  "snapshot_missing",
  "snapshot_wrong_provider",
  "snapshot_answer_missing",
  "template_valid",
  "template_missing",
  "template_revision",
  "template_account",
  "template_placement",
  "template_pending",
  "template_identity",
  "template_final_missing",
  "template_unknown",
  "template_refused",
  "template_no_answer",
  "template_full",
  "h_codex",
  "h_claude",
  "h_opencode",
  "h_missing",
  "h_failed",

  "control_steer",
  "control_interrupt",
  "control_echo",
  "control_finished",
  "control_unsupported",
  "control_api_unsupported",
  "control_full",
  "subscription",
  "subscription_priced",
  "subscription_bad_billing",
  "custom_unknown",
  "docker_send_pending",
  "github",
  "github_scp",
  "github_ssh",
  "github_auth_failed",
  "github_clone_failed",
  "github_push_failed",
  "github_invalid",
  "github_unbound",
  "github_unconfigured",
  "github_unsupported",
  "accounts",
  "accounts_api_equivalent",
  "accounts_subscription",
  "accounts_unknown",
  "accounts_invalid",
  "accounts_missing_model",
  "accounts_stop_unsupported",
  "accounts_unknown_bad",
  "accounts_price_lost",
  "offline",
  "unsupported",
  "delete_failure",
  "resume_failure",
  "filtered",
  "unimplemented",
  "idle-pause",
  "wake-on-send",
  "invalid_filter",
  "recall_loss",
  "quota",
  "resume_quota",
  "server_failure",
  "delete_retry",
  "journal_failure",
  "stop_response_lost",
  "terminal_failed",
  "already_deleted",
  "wrong_delete_id",
  "cost_mismatch",
  "usage_missing",
  "price_changed",
  "usage_filter",
  "usage_lost",
  "baseline_quota",
] as const) {
  test(`parity normal lifecycle and honest reporting: ${mode}`, async () => {
    const subscription = mode.startsWith("subscription") || mode === "accounts_subscription";
    const unpricedSubscription = mode === "subscription" || mode === "accounts_subscription";
    let clock = 0;
    const woken = new Set<string>();
    const idleReads = new Map<string, number>();

    const requestedHarness =
      mode === "h_claude" ? "claude-code" : mode === "h_opencode" || mode === "h_missing" ? "opencode" : "codex";
    const configuredHarness = mode === "h_claude" ? "claude" : mode === "h_opencode" ? "opencode" : "codex";
    const controlFeature = ["control_interrupt", "control_finished"].includes(mode) ? "interrupt" : "steer";
    const controlMarkers = new Map<string, string>();
    const controlled = new Set<string>();
    const journaled: string[] = [];
    const journalClaims: string[] = [];
    const templateCalls = new Map<string, number>();
    const templateRequests = new Map<string, object>();
    const debtFeature =
      mode === "unimplemented" ? "mcp" : mode === "idle-pause" || mode === "wake-on-send" ? mode : undefined;
    const lines: string[] = [];
    const calls: string[] = [];
    const deletes = new Map<string, number>();
    const detailReads = new Map<string, number>();
    const turns = new Map<string, string[]>();
    const prompts = new Map<string, string>();
    const states = new Map<string, string>();
    const providers = ["modal", "docker"];
    const passed = await postDeploySmoke(
      {
        ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
        ARMADA_TOKEN: "fake",
        ARMADA_SMOKE: "create_real_compute",
        ARMADA_SMOKE_CASES: JSON.stringify([
          { provider: "boat", org: null },
          ...(mode.startsWith("accounts") ? ["modal", "docker"] : providers).flatMap((provider) =>
            (mode.startsWith("accounts") ? ["codex-openai", "codex-azure"] : [undefined]).map((account) => ({
              ...(account ? { account: mode === "accounts_invalid" ? "unknown-account" : account } : {}),
              provider,
              ...(mode.startsWith("template_") && mode !== "template_missing"
                ? { template: { id: "10000000-0000-4000-8000-000000000001", revision: 2 } }
                : {}),
              org: provider,
              harness: configuredHarness,
              ...(mode === "accounts_missing_model" && account === "codex-azure"
                ? { model: "", notRunReason: "account has no declared model" }
                : { model: "fake-model" }),
              modelAccountId: "fake-account",
              golden: "fake-golden",
              hostId: "owned-host",
              ...(mode.startsWith("github") && mode !== "github_unconfigured"
                ? { githubRepository: mode === "github_invalid" ? "owner/repo'; echo unsafe" : "owner/private-fixture" }
                : {}),
            })),
          ),
          { provider: "boat", harness: "invalid" },
        ]),
      },
      mode.startsWith("idle_")
        ? ["--parity", "--feature", mode === "idle_pause" ? "idle-pause" : "wake-on-send"]
        : mode.startsWith("snapshot_")
          ? ["--parity", "--feature", "launch-snapshot"]
          : mode === "template_full"
            ? ["--parity"]
            : mode.startsWith("template_")
              ? ["--parity", "--feature", "templates"]
              : mode.startsWith("h_")
                ? ["--parity", "--feature", requestedHarness]
                : ["control_api_unsupported", "control_full"].includes(mode)
                  ? ["--parity"]
                  : mode.startsWith("control_")
                    ? ["--parity", "--feature", controlFeature]
                    : mode.startsWith("github")
                      ? ["--parity", "--feature", "github"]
                      : mode.startsWith("accounts")
                        ? ["--parity", "--accounts"]
                        : mode === "usage_filter"
                          ? ["--parity", "--only", "docker", "--feature", "exact-cost"]
                          : mode === "filtered"
                            ? ["--parity", "--only", "docker", "--feature", "exec"]
                            : debtFeature
                              ? ["--parity", "--feature", debtFeature]
                              : mode === "invalid_filter"
                                ? ["--parity", "--feature", "typo"]
                                : ["--parity"],
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        out: (line) => lines.push(line),
        recordSandbox: async (org, _id, requestKey, provider) => {
          journaled.push(org);
          journalClaims.push(_id);
          // Exercise the real journal validator, not a permissive callback.
          expect(String(provider)).toBe(org);
          smokeReceipts([{ org, id: "12345678-1234-1234-1234-123456789abc", requestKey, provider }]);
          if (mode === "journal_failure") throw new Error("journal_unwritable");
        },
        fetch: async (url, init) => {
          if (url.endsWith("/healthz"))
            return Response.json(
              mode.startsWith("idle_") ? { idlePauseDelayMs: mode === "idle_budget" ? 35 * 60_000 : 1000 } : {},
            );
          const path = url.split("/api/v1/")[1]!;
          const body = JSON.parse(String(init.body));
          const p = body.org;
          calls.push(`${p}:${path}`);
          let result: object;
          switch (path) {
            case "golden/list":
              result = {
                goldens: [
                  {
                    id: "golden-id",
                    name: "fake-golden",
                    provider: mode === "snapshot_wrong_provider" ? "docker" : p,
                    providerSnapshotId: mode === "snapshot_missing" ? null : "published-snapshot",
                  },
                ],
              };
              break;
            case "launch/options":
              result = {
                providers: providers.map((id) => ({
                  id,
                  harnesses: [configuredHarness],
                  capabilities: {
                    steer: mode.startsWith("control_") && mode !== "control_unsupported",
                    interrupt: mode.startsWith("control_") && mode !== "control_unsupported",
                    launch: true,
                    exec: true,
                    github: mode !== "github_unsupported",
                    followupPrompts: true,
                    status: true,
                    logs: true,
                    stop: mode !== "accounts_stop_unsupported",
                    resume: !(id === "docker" && mode === "unsupported"),
                    delete: true,
                  },
                  unsupportedReasons: {
                    steer: "Steer unavailable for this harness.",
                    interrupt: "Interrupt unavailable for this harness.",
                    github: "GitHub disabled by server.",
                    stop: "Stop unavailable | <test>\n(#1579)",
                    resume: "Server resume disabled.",
                  },
                })),
              };
              break;
            case "golden/size-policy":
              result = {
                provider: p,
                repositories:
                  mode === "github_unbound"
                    ? []
                    : [
                        {
                          url:
                            mode === "github_scp"
                              ? "git@github.com:owner/private-fixture.git"
                              : mode === "github_ssh"
                                ? "ssh://git@github.com/owner/private-fixture.git"
                                : "https://github.com/owner/private-fixture.git",
                        },
                      ],
              };
              break;
            case "docker/hosts/list":
              result = { hosts: [{ id: "owned-host", state: mode === "offline" ? "offline" : "online" }] };
              break;
            case "templates/launch": {
              const n = (templateCalls.get(p) ?? 0) + 1;
              templateCalls.set(p, n);
              if (n === 1) templateRequests.set(p, body);
              else expect(body).toEqual(templateRequests.get(p));
              expect(body.revision).toBe(2);
              expect(body.prompt).toBeUndefined();
              states.set(p, "ready");
              turns.set(p, []);
              result = {
                id:
                  mode === "template_final_missing" && n > 1
                    ? undefined
                    : mode === "template_identity" && n > 1
                      ? `${p}-other`
                      : p,
                ...(mode === "template_unknown" ||
                (["template_pending", "template_identity", "template_final_missing"].includes(mode) && n === 1)
                  ? {}
                  : { provider: p }),
                state:
                  mode === "template_refused"
                    ? "failed"
                    : (["template_pending", "template_identity", "template_final_missing"].includes(mode) && n === 1) ||
                        mode === "template_unknown"
                      ? "allocating"
                      : "succeeded",
                reason: "environment_unavailable",
                manifest: {
                  templateId: body.id,
                  revision: mode === "template_revision" ? 3 : 2,
                  account: { id: mode === "template_account" ? "wrong-account" : "fake-account", version: 1 },
                  golden: {
                    id: "golden-id",
                    name: mode === "template_placement" ? "wrong-golden" : "fake-golden",
                    provider: p,
                  },
                  definition: {
                    provider: p,
                    harness: "codex",
                    model: "fake-model",
                    goldenId: "golden-id",
                    hostId: mode === "template_placement" ? "wrong-host" : "owned-host",
                  },
                },
              };
              break;
            }
            case "sandbox/launch":
              if (mode.startsWith("snapshot_")) expect(body.golden).toBe("fake-golden");
              if (mode.startsWith("h_")) {
                expect(body.harness).toBe(configuredHarness);
                expect(body.credentialId).toBe("fake-account");
              }
              if (mode.startsWith("accounts")) turns.set(p, []);
              if (p === "docker") {
                expect(body).not.toHaveProperty("image");
                if (mode.startsWith("github") && mode !== "github_unconfigured")
                  expect(body.repos).toEqual([
                    {
                      url: "https://github.com/owner/private-fixture.git",
                      branch: "main",
                      dir: "armada-parity-github",
                    },
                  ]);
              }
              if (p === "modal" && (mode === "quota" || mode === "server_failure"))
                return Response.json(
                  {
                    error: {
                      code: mode === "quota" ? "rate_limited" : "forbidden",
                      message:
                        mode === "quota"
                          ? "The Modal plan start limit per day has been reached."
                          : `Access denied. token=do-not-print ghp_${"abcdefghijklmnopqrstuvwxyz0123456789"} sk-abcdefghijklmnopqrstuvwxyz eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl`,
                      details: { secret: "do-not-print-details" },
                    },
                  },
                  { status: mode === "quota" ? 429 : 403 },
                );
              states.set(p, "ready");
              result = { sandbox: { id: p, provider: p } };
              break;
            case "sandbox/wait":
              result = {
                prompt: {
                  promptId: turns.get(p)?.at(-1),
                  state: controlled.has(p) ? (mode === "control_finished" ? "finished" : "interrupted") : "running",
                },
              };
              break;
            case "sandbox/steer":
              if (mode === "control_api_unsupported")
                return Response.json(
                  { error: { code: "unsupported", message: "This harness cannot steer." } },
                  { status: 400 },
                );
              expect(body.text).toContain("Cancel the waiting task");
              controlMarkers.set(p, body.text.match(/PARITY_STEER_[a-z0-9]+/)[0]);
              result = { id: p, promptId: "steer-record", delivery: "restart" };
              break;
            case "sandbox/interrupt":
              controlled.add(p);
              result = { id: p, interrupted: true };
              break;
            case "sandbox/send": {
              if (mode.startsWith("idle_") && body.prompt.startsWith("What PARITY_")) {
                expect(states.get(p)).toBe("stopped");
                woken.add(p);
                if (mode === "idle_recall") prompts.delete(p);
              }
              if (mode === "docker_send_pending" && p === "docker")
                return Response.json(
                  { error: { code: "sandbox_not_ready", message: "Docker launch preparation is pending." } },
                  { status: 409 },
                );
              if (p !== "docker") expect(body.request_id).toBeUndefined();
              if (body.prompt.includes("Remember this token")) prompts.set(p, body.prompt.match(/PARITY_[a-z0-9]+/)[0]);
              states.set(p, p === "docker" ? "running" : "ready");
              const history = turns.get(p) ?? [];
              history.push(`turn-${history.length + 1}`);
              turns.set(p, history);
              result = { promptId: history.at(-1) };
              break;
            }
            case "logs/read":
              if (controlMarkers.has(p)) {
                result = {
                  events: [
                    {
                      kind: "message",
                      promptId: "steered-run",
                      text: controlMarkers.get(p),
                      partial: false,
                      responseKind: mode === "control_echo" ? "tool_result" : "assistant",
                    },
                    { kind: "prompt", promptId: "steered-run", status: "finished" },
                  ],
                };
                break;
              }
              result = {
                events: [
                  {
                    kind: "prompt",
                    promptId: turns.get(p)?.at(-1),
                    status: mode === "h_failed" ? "failed" : "finished",
                  },
                  {
                    kind: "message",
                    promptId: turns.get(p)?.at(-1),
                    partial: false,
                    text:
                      mode === "snapshot_answer_missing" || mode === "template_no_answer"
                        ? "WRONG"
                        : mode.startsWith("idle_") && woken.has(p)
                          ? prompts.get(p)
                          : `SMOKE_OK ${prompts.get(p)}`,
                  },
                ],
              };
              break;
            case "sandbox/exec":
              if (String(body.command).includes("PARITY_GITHUB_OK")) {
                expect(body.command).toContain("clone --quiet");
                expect(body.command).toContain("core.hooksPath=/dev/null");
                expect(body.command).toContain("push --dry-run");
                expect(body.command).toContain(".private and .permissions.push");
                expect(body.command).toContain("trap ");
                expect(body.command).not.toContain("Bearer");
                result =
                  mode === "github_auth_failed"
                    ? { exitCode: 11, timedOut: false, stdout: "PARITY_GITHUB_AUTH_FAILED" }
                    : mode === "github_clone_failed"
                      ? { exitCode: 12, timedOut: false, stdout: "PARITY_GITHUB_CLONE_FAILED" }
                      : mode === "github_push_failed"
                        ? { exitCode: 13, timedOut: false, stdout: "PARITY_GITHUB_PUSH_FAILED" }
                        : { exitCode: 0, timedOut: false, stdout: "PARITY_GITHUB_OK" };
                break;
              }
              result = { exitCode: 0, timedOut: false, stdout: "PARITY_EXEC_OK" };
              break;
            case "sandbox/detail":
            case "sandbox/status":
              if (mode.startsWith("idle_")) {
                const n = (idleReads.get(p) ?? 0) + 1;
                idleReads.set(p, n);
                const paused = !woken.has(p) && n > 2;
                if (paused) states.set(p, "stopped");
                result = {
                  id: p,
                  status: paused ? "stopped" : states.get(p),
                  idlePaused: paused,
                  statusReason: paused ? (mode === "idle_wrong_reason" ? "explicit_stop" : "idle_paused") : null,
                  expiresAt: paused && mode === "idle_expiry" ? "2099-02-01T00:00:00Z" : "2099-01-01T00:00:00Z",
                  conversationIds: [
                    woken.has(p) && mode === "idle_conversation" ? "new-conversation" : "original-conversation",
                  ],
                };
                break;
              }
              detailReads.set(p, (detailReads.get(p) ?? 0) + 1);
              if (mode === "baseline_quota" && path === "sandbox/detail" && detailReads.get(p) === 1)
                return Response.json(
                  { error: { code: "rate_limited", message: "Read quota reached." } },
                  { status: 429 },
                );
              result = {
                id: mode === "template_identity" ? body.id : p,
                status: states.get(p),
                usage: {
                  turnCount: turns.get(p)?.length ?? 0,
                  turns: (mode === "usage_lost" && (turns.get(p)?.length ?? 0) > 1
                    ? (turns.get(p) ?? []).slice(-1)
                    : (turns.get(p) ?? [])
                  ).map((promptId, i) => ({
                    promptId,
                    model: "fake-model",
                    inputTokens: mode === "usage_missing" ? null : 10,
                    outputTokens: 5,
                    pricing: {
                      ...(subscription
                        ? {
                            basis: "api_equivalent",
                            billing: mode === "subscription_bad_billing" ? "per_token" : "subscription",
                            credentialId: "account",
                          }
                        : {}),
                      unknown:
                        unpricedSubscription ||
                        ["accounts_unknown", "custom_unknown"].includes(mode) ||
                        (mode === "accounts_price_lost" && (turns.get(p)?.length ?? 0) > 1)
                          ? "price"
                          : null,
                      usd:
                        unpricedSubscription ||
                        ["accounts_unknown", "custom_unknown"].includes(mode) ||
                        (mode === "accounts_price_lost" && (turns.get(p)?.length ?? 0) > 1)
                          ? null
                          : mode === "price_changed" && (turns.get(p)?.length ?? 0) > 1
                            ? i === 0
                              ? "0.2"
                              : i === 1
                                ? "0.0"
                                : "0.1"
                            : "0.1",
                    },
                  })),
                  cost: {
                    classification: subscription
                      ? "included_in_subscription"
                      : mode.startsWith("accounts_unknown") ||
                          mode === "custom_unknown" ||
                          mode === "accounts_price_lost"
                        ? "unknown"
                        : "priced",
                    currency: "USD",
                    basis: subscription || mode === "accounts_api_equivalent" ? "api_equivalent" : "estimated",
                    unknown:
                      mode.startsWith("accounts_unknown") ||
                      unpricedSubscription ||
                      mode === "custom_unknown" ||
                      (mode === "accounts_price_lost" && (turns.get(p)?.length ?? 0) > 1)
                        ? "price"
                        : null,
                    unpricedTurns:
                      mode.startsWith("accounts_unknown") ||
                      unpricedSubscription ||
                      mode === "custom_unknown" ||
                      (mode === "accounts_price_lost" && (turns.get(p)?.length ?? 0) > 1)
                        ? turns.get(p)?.length
                        : 0,
                    usd:
                      mode.startsWith("accounts_unknown") ||
                      unpricedSubscription ||
                      mode === "custom_unknown" ||
                      (mode === "accounts_price_lost" && (turns.get(p)?.length ?? 0) > 1)
                        ? null
                        : mode === "cost_mismatch"
                          ? "99"
                          : `0.${turns.get(p)?.length ?? 0}`,
                  },
                },
              };
              break;
            case "sandbox/stop":
              states.set(p, mode === "already_deleted" ? "deleted" : mode === "terminal_failed" ? "failed" : "stopped");
              if (mode === "recall_loss") prompts.delete(p);
              if (mode === "stop_response_lost") throw new Error("stop_response_lost");
              result = { status: "stopped" };
              break;
            case "sandbox/resume":
              if (mode === "resume_quota")
                return Response.json(
                  { error: { code: "rate_limited", message: "Start quota reached." } },
                  { status: 429 },
                );
              expect(p).toBe("docker");
              states.set(p, "ready");
              if (mode === "resume_failure") throw new Error("lost_resume_response");
              result = { status: "ready" };
              break;
            case "sandbox/delete":
              deletes.set(p, (deletes.get(p) ?? 0) + 1);
              if (mode === "delete_retry" && p === "modal" && deletes.get(p) === 1)
                return Response.json(
                  { error: { code: "conflict", message: "Provider deletion is pending." } },
                  { status: 409 },
                );
              expect(["stopped", "failed"]).toContain(states.get(p) ?? "missing");
              result = {
                id: mode === "wrong_delete_id" ? "another-sandbox" : mode === "template_identity" ? body.id : p,
                status: mode === "delete_failure" && p === "docker" ? "pending" : "deleted",
              };
              break;
            default:
              throw new Error(`Unexpected route ${path}`);
          }
          return Response.json(result);
        },
      },
    );
    expect(lines.filter((line) => line === boatNotice)).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("boat:"))).toBe(false);
    if (mode.startsWith("accounts")) {
      if (mode === "accounts_invalid") {
        expect(passed).toBe(false);
        expect(calls).toHaveLength(0);
        expect(JSON.parse(lines.find((line) => line.startsWith("{"))!)).toMatchObject({
          code: "invalid_accounts_configuration",
          field: "ARMADA_SMOKE_CASES[1].account",
        });
        return;
      }
      const badCost = mode === "accounts_unknown_bad" || mode === "accounts_price_lost";
      expect(passed).toBe(!badCost);
      const report = JSON.parse(lines.find((line) => line.startsWith('{"step":"accounts_parity"'))!);
      const summary = lines.find((line) => line.startsWith("## Accounts parity\n")) ?? "";
      expect(summary).toContain("## Account feature and cost details");
      expect(summary).toContain("| Account | Provider | Feature | Result |");
      expect(summary).toContain("| codex-subscription | modal | all | not-run: no account on staging |");
      for (const account of ["codex-openai", "codex-azure"]) {
        for (const provider of ["modal", "docker"]) {
          const cell = report.accounts[account][provider];
          if (mode === "accounts_missing_model" && account === "codex-azure") {
            expect(cell).toEqual({ status: "not-run", reason: "account has no declared model" });
            expect(lines.join("\n")).toContain(
              `| codex-azure | ${provider} | not-run: account has no declared model |`,
            );
            expect(summary).toContain(`| codex-azure | ${provider} | all | not-run: account has no declared model |`);
            continue;
          }
          expect(summary).toContain(`| ${account} | ${provider} | launch | pass |`);
          expect(summary).toContain(`| ${account} | ${provider} | mcp | not-run: probe_not_implemented |`);
          expect(summary).toContain(`| ${account} | ${provider} | resume-recall | pass |`);
          expect(summary).toContain(`| ${account} | ${provider} | usage-after-resume | pass |`);
          const cost = subscription
            ? "pass: included in subscription"
            : badCost
              ? "fail: invalid_cost_receipt"
              : mode === "accounts_unknown"
                ? "pass: unknown: price"
                : `pass: ${mode === "accounts_api_equivalent" ? "api_equivalent" : "estimated"}: USD 0.3`;
          expect(summary).toContain(`| ${account} | ${provider} | exact-cost | ${cost} |`);
          if (mode === "accounts_stop_unsupported")
            expect(summary).toContain(
              `| ${account} | ${provider} | stop | unsupported: Stop unavailable \\| &lt;test&gt; (#1579) |`,
            );
          expect(cell.status).toBe(badCost ? "fail" : mode === "accounts_stop_unsupported" ? "not-run" : "pass");
          expect(cell.features["resume-recall"][provider].status).toBe("pass");
          if (mode === "accounts_unknown") expect(cell.features["exact-cost"][provider].reason).toBe("unknown: price");
        }
      }
      expect(lines.join("\n")).toContain("| claude-anthropic | modal | not-run: no account on staging |");
      expect(lines.join("\n")).toContain("| codex-subscription | docker | not-run: no account on staging |");
      expect(report.accounts["codex-subscription"].modal).toEqual({
        status: "not-run",
        reason: "no account on staging",
      });
      expect(calls.filter((call) => call.endsWith(":sandbox/launch"))).toHaveLength(
        mode === "accounts_missing_model" ? 2 : 4,
      );
      expect(calls.filter((call) => call.endsWith(":sandbox/delete"))).toHaveLength(
        mode === "accounts_missing_model" ? 2 : 4,
      );
      expect(calls.some((call) => call.startsWith("boat:"))).toBe(false);
      return;
    }
    if (mode === "github_invalid") {
      expect(passed).toBe(false);
      expect(calls).toHaveLength(0);
      expect(lines.join("\n")).toContain("invalid_configuration");
      return;
    }
    if (mode === "invalid_filter") {
      expect(passed).toBe(false);
      expect(calls).toHaveLength(0);
      expect(lines.some((line) => line.includes("invalid_parity_filter"))).toBe(true);
      return;
    }
    const report = JSON.parse(lines.find((line) => line.startsWith('{"step":"provider_parity"'))!);
    for (const cells of Object.values(report.features) as Record<string, unknown>[])
      expect(cells.boat).toEqual(boatNotRun);
    if (mode === "github_unbound") {
      expect(passed).toBe(false);
      expect(report.features.github.modal.status).toBe("fail");
      expect(report.features.github.modal.diagnostic.code).toBe("github_repository_not_in_golden");
      expect(report.features.github.docker.status).toBe("pass");
      expect(calls).not.toContain("modal:sandbox/launch");
      return;
    }
    if (mode.startsWith("github")) {
      expect(passed).toBe(!["github_auth_failed", "github_clone_failed", "github_push_failed"].includes(mode));
      for (const provider of providers) {
        const cell = report.features.github[provider];
        expect(cell.status).toBe(
          mode === "github_unconfigured"
            ? "not-run"
            : mode === "github_unsupported"
              ? "unsupported"
              : ["github", "github_scp", "github_ssh"].includes(mode)
                ? "pass"
                : "fail",
        );
        if (mode === "github_unconfigured") expect(calls).toHaveLength(0);
        else expect(report.features.cleanup[provider].status).toBe("pass");
      }
      expect(calls.filter((call) => call.endsWith(":sandbox/launch"))).toHaveLength(
        mode === "github_unconfigured" ? 0 : 2,
      );
      return;
    }
    if (mode === "filtered" || debtFeature) {
      expect(passed).toBe(true);
      if (debtFeature) {
        expect(calls).toHaveLength(0);
        expect(report.starts).toBe(0);
        for (const provider of providers)
          expect(report.features[debtFeature][provider]).toEqual({
            status: "not-run",
            reason: debtFeature === "mcp" ? "probe_not_implemented" : "idle_delay_not_advertised",
          });
      } else {
        expect(report.features.exec.docker.status).toBe("pass");
        expect(report.features.exec.boat).toEqual(boatNotRun);
        expect(calls.filter((call) => call.endsWith(":sandbox/launch"))).toEqual(["docker:sandbox/launch"]);
        expect(calls).not.toContain("docker:sandbox/send");
        expect(calls).toContain("docker:sandbox/delete");
      }
      return;
    }
    if (
      mode === "journal_failure" ||
      mode === "stop_response_lost" ||
      mode === "resume_failure" ||
      mode === "terminal_failed" ||
      mode === "already_deleted"
    ) {
      expect(passed).toBe(false);
      for (const provider of providers) {
        expect(report.features.cleanup[provider].status).toBe("pass");
        if (mode === "already_deleted") expect(calls).not.toContain(`${provider}:sandbox/delete`);
        else expect(calls).toContain(`${provider}:sandbox/delete`);
      }
      if (mode === "stop_response_lost") {
        // Unknown stop outcome is reconciled with status, not replayed.
        for (const provider of providers)
          expect(calls.filter((call) => call === `${provider}:sandbox/stop`)).toHaveLength(1);
      }
      return;
    }
    if (mode === "baseline_quota") {
      expect(passed).toBe(true);
      expect(report.features["exact-cost-before-resume"].docker.status).toBe("not-run");
      expect(report.features["exact-cost-after-resume"].docker.status).toBe("pass");
      expect(report.features["exact-cost"].docker.status).toBe("not-run");
      return;
    }
    if (mode.startsWith("h_")) {
      expect(passed).toBe(mode !== "h_failed");
      for (const provider of ["modal", "docker"]) {
        const cell = report.features[requestedHarness][provider];
        expect(cell.status).toBe(mode === "h_missing" || mode === "h_failed" ? "not-run" : "pass");
        if (mode === "h_missing") {
          expect(cell.reason).toBe("harness_account_not_configured");
          expect(calls).not.toContain(`${provider}:sandbox/launch`);
        } else {
          expect(calls.filter((call) => call === `${provider}:sandbox/launch`)).toHaveLength(1);
          expect(turns.get(provider)).toHaveLength(1);
          expect(report.features.cleanup[provider].status).toBe("pass");
          if (mode === "h_failed") expect(cell.reason).toBe("send: turn_failed");
        }
      }
      return;
    }

    if (mode === "subscription_bad_billing") {
      expect(passed).toBe(false);
      expect(report.features["exact-cost"].modal).toMatchObject({ status: "fail", reason: "invalid_cost_receipt" });
      return;
    }
    if (subscription || mode === "custom_unknown") {
      expect(passed).toBe(true);
      for (const provider of ["modal", "docker"]) {
        for (const name of ["exact-cost", "exact-cost-before-resume", "exact-cost-after-resume"])
          expect(report.features[name][provider]).toMatchObject({
            status: "pass",
            reason: subscription ? "included in subscription" : "unknown: price",
          });
        expect(turns.get(provider)).toHaveLength(2);
      }
      return;
    }
    if (mode.startsWith("idle_")) {
      const failure = ["idle_wrong_reason", "idle_expiry", "idle_conversation", "idle_recall"].includes(mode);
      expect(passed).toBe(!failure);
      if (mode === "idle_budget") {
        expect(report.starts).toBe(0);
        expect(report.features["wake-on-send"].docker.reason).toBe("idle_observation_exceeds_run_budget");
        return;
      }
      for (const provider of ["modal", "docker"]) {
        const selected = mode === "idle_pause" ? "idle-pause" : "wake-on-send";
        expect(report.features[selected][provider].status).toBe(failure ? "fail" : "pass");
        expect(report.features.cleanup[provider].status).toBe("pass");
        expect(calls.filter((call) => call === `${provider}:sandbox/launch`)).toHaveLength(1);
        expect(calls).not.toContain(`${provider}:sandbox/resume`);
        const firstDetail = calls.indexOf(`${provider}:sandbox/detail`);
        expect(calls.indexOf(`${provider}:sandbox/stop`)).toBeGreaterThan(firstDetail);
      }
      return;
    }

    if (mode === "control_full") {
      expect(passed).toBe(true);
      for (const provider of ["modal", "docker"]) {
        expect(report.features.steer[provider].status).toBe("pass");
        expect(report.features.interrupt[provider].status).toBe("pass");
        expect(calls.filter((call) => call === `${provider}:sandbox/launch`)).toHaveLength(1);
        expect(turns.get(provider)).toHaveLength(4);
        expect(report.features.cleanup[provider].status).toBe("pass");
      }
      return;
    }
    if (mode === "control_api_unsupported") {
      expect(passed).toBe(true);
      for (const provider of ["modal", "docker"]) {
        expect(report.features.steer[provider].status).toBe("unsupported");
        expect(report.features.interrupt[provider]).toMatchObject({
          status: "not-run",
          reason: "steer_failed",
          diagnostic: { code: "unsupported" },
        });
        expect(calls).not.toContain(`${provider}:sandbox/interrupt`);
        expect(report.features.cleanup[provider].status).toBe("pass");
      }
      return;
    }
    if (mode.startsWith("control_")) {
      const fail = mode === "control_echo" || mode === "control_finished";
      expect(passed).toBe(!fail);
      for (const provider of ["modal", "docker"]) {
        expect(report.features[controlFeature][provider].status).toBe(
          mode === "control_unsupported" ? "unsupported" : fail ? "fail" : "pass",
        );
        expect(calls.filter((call) => call === `${provider}:sandbox/launch`)).toHaveLength(1);
        expect(report.features.cleanup[provider].status).toBe("pass");
        expect(turns.get(provider)?.length ?? 0).toBe(mode === "control_unsupported" ? 0 : 1);
      }
      return;
    }
    if (mode.startsWith("snapshot_")) {
      expect(passed).toBe(mode === "snapshot_valid");
      expect(report.features["launch-snapshot"].docker.status).toBe("unsupported");
      expect(calls).not.toContain("docker:sandbox/launch");
      if (mode === "snapshot_valid" || mode === "snapshot_answer_missing") {
        expect(report.starts).toBe(1);
        expect(turns.get("modal")).toHaveLength(1);
        expect(report.features["launch-snapshot"].modal.status).toBe(mode === "snapshot_valid" ? "pass" : "not-run");
        expect(report.features.cleanup.modal.status).toBe("pass");
      } else {
        expect(report.starts).toBe(0);
        expect(report.features["launch-snapshot"].modal.diagnostic.code).toBe("invalid_snapshot_source");
      }
      return;
    }
    if (mode.startsWith("template_")) {
      const failure = [
        "template_revision",
        "template_account",
        "template_placement",
        "template_refused",
        "template_no_answer",
        "template_unknown",
        "template_identity",
        "template_final_missing",
      ].includes(mode);
      expect(passed).toBe(!failure);
      expect(report.starts).toBe(mode === "template_missing" ? 0 : mode === "template_full" ? 4 : 2);
      for (const provider of ["modal", "docker"]) {
        expect(report.features.templates[provider].status).toBe(
          mode === "template_missing" || failure ? "not-run" : "pass",
        );
        if (mode === "template_missing")
          expect(report.features.templates[provider].reason).toBe("template_revision_not_configured");
        else {
          expect(templateCalls.get(provider)).toBe(
            mode === "template_unknown"
              ? 600
              : ["template_pending", "template_identity", "template_final_missing"].includes(mode)
                ? 2
                : 1,
          );
          expect(journaled).toContain(provider);
          if (mode === "template_identity") {
            expect(journalClaims).toContain(provider);
            expect(journalClaims).toContain(`${provider}-other`);
            expect(calls.filter((call) => call === `${provider}:sandbox/delete`)).toHaveLength(2);
          }
          expect(report.features[mode === "template_full" ? "templates-cleanup" : "cleanup"][provider].status).toBe(
            "pass",
          );
          if (mode === "template_refused")
            expect(report.features.templates[provider].diagnostic.code).toBe("environment_unavailable");
        }
      }
      return;
    }
    if (mode === "docker_send_pending") {
      expect(passed).toBe(false);
      for (const name of ["resume-recall", "usage", "exact-cost"]) {
        expect(report.features[name].docker).toMatchObject({
          status: "not-run",
          reason: "send: sandbox_not_ready",
          diagnostic: { code: "sandbox_not_ready", httpStatus: 409 },
        });
      }
      expect(report.features.cleanup.docker.status).toBe("pass");
      expect(calls.filter((call) => call === "docker:sandbox/launch")).toHaveLength(1);
      return;
    }
    if (mode === "online") {
      for (const provider of ["modal", "docker"]) {
        for (const name of [
          "resume-recall",
          "usage",
          "exact-cost",
          "usage-before-resume",
          "usage-after-resume",
          "exact-cost-before-resume",
          "exact-cost-after-resume",
        ])
          expect(report.features[name][provider].status).toBe("pass");
        expect(calls.filter((call) => call === `${provider}:sandbox/launch`)).toHaveLength(1);
        expect(turns.get(provider)).toHaveLength(2);
      }
    }
    if (["cost_mismatch", "usage_missing", "price_changed", "usage_filter", "usage_lost"].includes(mode)) {
      const cell = report.features["exact-cost"].docker;
      expect(cell.status).toBe(mode === "usage_filter" ? "pass" : "fail");
      expect(passed).toBe(mode === "usage_filter");
      expect(report.features.cleanup.docker.status).toBe("pass");
      if (mode === "usage_filter") {
        expect(calls.filter((call) => call.endsWith(":sandbox/launch"))).toEqual(["docker:sandbox/launch"]);
        expect(turns.get("docker")).toHaveLength(2);
        expect(report.features["exact-cost-before-resume"].docker.status).toBe("pass");
        expect(report.features["exact-cost-after-resume"].docker.status).toBe("pass");
      }
      return;
    }
    if (mode === "wrong_delete_id") {
      expect(passed).toBe(false);
      expect(report.features.cleanup.docker.status).toBe("fail");
      expect(
        lines.filter((line) => line.includes('"step":"parity_cleanup"')).every((line) => !JSON.parse(line).deleted),
      ).toBe(true);
      return;
    }
    expect(report.starts).toBe(mode === "offline" ? 1 : 2);
    if (mode === "quota" || mode === "server_failure") {
      const cell = report.features.launch.modal;
      expect(cell.status).toBe(mode === "quota" ? "not-run" : "fail");
      expect(cell.diagnostic.httpStatus).toBe(mode === "quota" ? 429 : 403);
      expect(cell.diagnostic.code).toBe(mode === "quota" ? "rate_limited" : "forbidden");
      expect(report.features.send.modal.status).toBe(cell.status);
      expect(passed).toBe(mode === "quota");
      expect(lines.join("\n")).not.toContain("do-not-print");
      expect(lines.join("\n")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
      expect(lines.join("\n")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
      expect(lines.join("\n")).not.toContain("eyJhbGci");
      expect(lines.at(-1)).toContain(mode === "quota" ? "HTTP 429" : "HTTP 403");
      return;
    }
    if (mode === "resume_quota") {
      expect(report.features.resume.docker.status).toBe("not-run");
      expect(report.features["resume-recall"].docker.status).toBe("not-run");
      expect(report.features["resume-recall"].docker.diagnostic.httpStatus).toBe(429);
      expect(passed).toBe(true);
      expect(report.features["exact-cost"].docker.status).toBe("not-run");
      return;
    }
    if (mode === "delete_retry") expect(deletes.get("modal")).toBe(2);
    expect(report.features.launch.modal.status).toBe("pass");
    expect(report.features.delete.modal.status).toBe("pass");
    expect(passed).toBe(mode === "online" || mode === "unsupported" || mode === "delete_retry");
    expect(lines.at(-1)).toContain("| Feature | Boat | Modal | Docker |");
    if (mode === "offline") {
      expect(report.features.launch.docker).toEqual({ status: "fail", reason: "host_offline" });
      expect(calls).not.toContain("docker:sandbox/launch");
      expect(lines.filter((line) => line.includes('"step":"host_offline"'))).toHaveLength(1);
    } else if (mode === "unsupported") {
      expect(report.features.resume.docker).toEqual({ status: "unsupported", reason: "Server resume disabled." });
      expect(calls).not.toContain("docker:sandbox/resume");
    } else if (mode === "recall_loss") expect(report.features["resume-recall"].modal.status).toBe("fail");
    else if (mode === "delete_failure") expect(report.features.delete.docker.status).toBe("fail");
    else expect(report.features.resume.docker.status).toBe("pass");
  });
}

test("parity --only boat is an owner-decision not-run report, never allocation or proof", async () => {
  const lines: string[] = [];
  const calls: string[] = [];
  const passed = await postDeploySmoke(
    {
      ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
      ARMADA_TOKEN: "fake",
      ARMADA_SMOKE: "create_real_compute",
      ARMADA_SMOKE_CASES: JSON.stringify([{ provider: "boat", org: null, harness: "invalid" }]),
    },
    ["--parity", "--only", "boat"],
    {
      now: () => 0,
      sleep: async () => {},
      out: (line) => lines.push(line),
      fetch: async (url) => {
        calls.push(url);
        throw new Error("Boat staging must never call an API");
      },
    },
  );
  expect(passed).toBe(false);
  expect(calls).toHaveLength(0);
  expect(lines.filter((line) => line === boatNotice)).toHaveLength(1);
  const report = JSON.parse(lines.find((line) => line.startsWith('{"step":"provider_parity"')) ?? "{}");
  expect(report.starts).toBe(0);
  for (const cells of Object.values(report.features) as Record<string, unknown>[])
    expect(cells.boat).toEqual(boatNotRun);
});

const productionBoatCase = {
  provider: "boat",
  org: "production-org",
  harness: "codex",
  model: "selected-model",
  modelAccountId: "selected-account",
  golden: "selected-golden",
};
const productionBoatEnv = {
  ARMADA_URL: "https://production.invalid",
  ARMADA_TOKEN: "fake",
  ARMADA_SMOKE: "create_real_compute",
  ARMADA_SMOKE_CASES: JSON.stringify([productionBoatCase]),
};
const productionBoatArgs = ["--production-boat", "--only", "boat"];

function productionBoatFixture(
  fault?:
    | "foreign_provider"
    | "ambiguous_launch"
    | "delete_failed"
    | "slow_turn"
    | "turn_timeout"
    | "stop_settling"
    | "late_success"
    | "deadline_exhausted",
) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const lines: string[] = [];
  let status = "ready";
  let memory = "";
  const turns: string[] = [];
  let journalWrites = 0;
  let clock = 0;
  let reads = 0;
  let deleteAttempts = 0;
  const io = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    out: (line: string) => lines.push(line),
    recordSandbox: async () => {
      journalWrites++;
    },
    fetch: async (url: string, init: RequestInit) => {
      expect(new URL(url).origin).toBe(productionBoatEnv.ARMADA_URL);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fake");
      expect(init.redirect).toBe("error");
      const path = new URL(url).pathname.slice("/api/v1/".length);
      const body = JSON.parse(String(init.body));
      calls.push({ path, body });
      if (body.id !== undefined) expect(body.id).toBe("new-production-boat");
      switch (path) {
        case "golden/list":
          return Response.json({
            goldens: [
              {
                id: "golden-id",
                name: productionBoatCase.golden,
                provider: "boat",
                providerSnapshotId: "published-snapshot",
              },
            ],
          });
        case "launch/options":
          return Response.json({
            providers: [
              {
                id: "boat",
                harnesses: ["codex"],
                capabilities: {
                  steer: false,
                  interrupt: false,
                  launch: true,
                  followupPrompts: true,
                  status: true,
                  logs: true,
                  exec: true,
                  stop: true,
                  resume: true,
                  delete: true,
                },
                unsupportedReasons: { steer: "Unavailable", interrupt: "Unavailable" },
              },
            ],
          });
        case "golden/size-policy":
          return Response.json({
            provider: "boat",
            repositories: [{ url: "https://github.com/owner/private-fixture.git" }],
          });
        case "sandbox/launch":
          if (fault === "deadline_exhausted") clock += 35 * 60_000;
          expect(body.provider).toBe("boat");
          if (fault === "ambiguous_launch") throw new Error("lost launch acknowledgement");
          return Response.json({
            sandbox: { id: "new-production-boat", provider: fault === "foreign_provider" ? "modal" : "boat" },
          });
        case "sandbox/send":
          status = "ready";
          if (String(body.prompt).includes("Remember this token"))
            memory = String(body.prompt).match(/PARITY_[a-z0-9]+/)?.[0] ?? "";
          turns.push(`turn-${turns.length + 1}`);
          return Response.json({ promptId: turns.at(-1) });
        case "logs/read":
          if (fault === "late_success") clock += 601_000;
          if (fault === "slow_turn" || fault === "turn_timeout") {
            clock += 2000;
            reads++;
            if (fault === "turn_timeout" || reads <= 130)
              return Response.json({
                events: [{ kind: "prompt", promptId: turns.at(-1), status: "running", at: 1_000_000 }],
              });
          }
          return Response.json({
            events: [
              { kind: "prompt", promptId: turns.at(-1), status: "running", at: 1_000_000 },
              { kind: "prompt", promptId: turns.at(-1), status: "finished", at: 1_180_000 },
              { kind: "message", promptId: turns.at(-1), text: `SMOKE_OK ${memory}` },
            ],
          });
        case "sandbox/detail":
          return Response.json({
            usage: {
              turnCount: turns.length,
              turns: turns.map((promptId) => ({
                promptId,
                model: "selected-model",
                inputTokens: 10,
                outputTokens: 2,
                pricing: { unknown: null, usd: "0.1" },
              })),
              cost: {
                classification: "priced",
                currency: "USD",
                unknown: null,
                unpricedTurns: 0,
                usd: `0.${turns.length}`,
              },
            },
          });
        case "sandbox/status":
          return Response.json({ id: "new-production-boat", status });
        case "sandbox/exec":
          return Response.json({
            exitCode: 0,
            timedOut: false,
            stdout: String(body.command).includes("PARITY_GITHUB_OK") ? "PARITY_GITHUB_OK" : "PARITY_EXEC_OK",
          });
        case "sandbox/stop":
          status = "stopped";
          return Response.json({ status });
        case "sandbox/delete":
          deleteAttempts++;
          if (fault === "stop_settling" && deleteAttempts <= 2)
            return Response.json(
              { error: { code: "sandbox_not_ready", message: "Stop is still settling." } },
              { status: 409 },
            );
          if (fault === "delete_failed") return Response.json({ error: { code: "forbidden" } }, { status: 403 });
          status = "deleted";
          return Response.json({ id: "new-production-boat", status });
        default:
          throw new Error(`Unexpected production route ${path}`);
      }
    },
  };
  return { io, calls, lines, journalWrites: () => journalWrites };
}

function runProductionBoat(env: NodeJS.ProcessEnv, io: ReturnType<typeof productionBoatFixture>["io"], args: string[]) {
  return postDeploySmoke(env, ["--parity", ...args], io);
}

test("production Boat verification requires coordinator opt-in and rejects unsafe configuration before traffic", async () => {
  const cases = [
    { args: ["--only", "boat"] },
    { args: ["--production-boat"] },
    { args: ["--production-boat", "--only", "modal"] },
    { args: ["--production-boat", "--only", "docker"] },
    { args: [...productionBoatArgs, "--production-boat"] },
    { args: [...productionBoatArgs, "--only", "boat"] },
    { args: [...productionBoatArgs, "--unknown"] },
    { args: [...productionBoatArgs, "--feature", "exec", "--feature", "exec"] },
    { args: [...productionBoatArgs, "--accounts"] },
    ...[
      { ARMADA_URL: "https://armada-mcp-staging.up.railway.app" },
      { ARMADA_URL: "http://production.invalid" },
      { ARMADA_URL: "https://user@production.invalid" },
      { ARMADA_URL: "https://production.invalid/api" },
      { ARMADA_URL: "https://production.invalid/?key=value" },
      { ARMADA_URL: "https://production.invalid/#fragment" },
      { ARMADA_URL: "" },
      { ARMADA_TOKEN: "" },
      { ARMADA_SMOKE: "" },
      { CI: "false" },
      { GITHUB_ACTIONS: "false" },
      { ARMADA_SMOKE_JOURNAL: "/tmp/preexisting-journal" },
      { ARMADA_SMOKE_CASES: JSON.stringify([{ ...productionBoatCase, provider: "modal" }]) },
      { ARMADA_SMOKE_CASES: JSON.stringify([{ ...productionBoatCase, provider: "docker" }]) },
      { ARMADA_SMOKE_CASES: JSON.stringify([productionBoatCase, productionBoatCase]) },
      { ARMADA_SMOKE_CASES: JSON.stringify([{ ...productionBoatCase, harness: "unknown" }]) },
      { ARMADA_SMOKE_CASES: JSON.stringify([{ ...productionBoatCase, golden: "" }]) },
    ].map((env) => ({ env })),
  ];
  for (const scenario of cases) {
    const fake = productionBoatFixture();
    expect(
      await runProductionBoat(
        { ...productionBoatEnv, ...("env" in scenario ? scenario.env : {}) },
        fake.io,
        "args" in scenario ? scenario.args : productionBoatArgs,
      ),
    ).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(fake.journalWrites()).toBe(0);
  }
});

for (const fault of [undefined, "foreign_provider", "ambiguous_launch", "delete_failed"] as const) {
  test(`production Boat verifies only its new allocation and never stage journals: ${fault ?? "happy"}`, async () => {
    const fake = productionBoatFixture(fault);
    expect(
      await runProductionBoat(
        {
          ...productionBoatEnv,
          ARMADA_SMOKE_CASES: JSON.stringify([
            { provider: "modal", harness: null },
            productionBoatCase,
            { provider: "docker" },
          ]),
        },
        fake.io,
        productionBoatArgs,
      ),
    ).toBe(fault === undefined);
    expect(fake.lines.filter((line) => line === "boat: production verification (coordinator opt-in)")).toHaveLength(1);
    expect(fake.lines).not.toContain(boatNotice);
    expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(1);
    expect(fake.journalWrites()).toBe(0);
    const report = JSON.parse(fake.lines.find((line) => line.startsWith('{"step":"provider_parity"')) ?? "{}");
    if (fault === "foreign_provider" || fault === "ambiguous_launch") {
      expect(fake.calls.map((call) => call.path)).toEqual(["launch/options", "golden/list", "sandbox/launch"]);
      expect(report.features.launch.boat.status).toBe("fail");
      expect(fake.lines.some((line) => line.includes('"step":"parity_cleanup"'))).toBe(false);
    } else {
      expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toHaveLength(2);
      expect(fake.calls.some((call) => call.path === "sandbox/delete")).toBe(true);
      const cleanup = JSON.parse(fake.lines.find((line) => line.startsWith('{"step":"parity_cleanup"')) ?? "{}");
      expect(cleanup).toMatchObject({ provider: "boat", id: "new-production-boat", deleted: fault === undefined });
      expect(report.features.cleanup.boat.status).toBe(fault ? "fail" : "pass");
      for (const step of [
        "launch",
        "send",
        "status",
        "logs",
        "exec",
        "stop",
        "resume",
        "resume-recall",
        "usage",
        "exact-cost",
      ])
        expect(report.features[step].boat.status).toBe("pass");
      expect(report.features.mcp.boat).toEqual({ status: "not-run", reason: "probe_not_implemented" });
      expect(report.features.launch.modal.reason).toBe("provider_filtered");
      expect(report.features.launch.docker.reason).toBe("provider_filtered");
    }
  });
}

test("production Boat preserves capability discovery and feature-filtered probes", async () => {
  const refused = productionBoatFixture();
  expect(
    await runProductionBoat(
      {
        ...productionBoatEnv,
        ARMADA_SMOKE_CASES: JSON.stringify([{ ...productionBoatCase, harness: "claude" }]),
      },
      refused.io,
      productionBoatArgs,
    ),
  ).toBe(false);
  expect(refused.calls.map((call) => call.path)).toEqual(["launch/options"]);

  const filtered = productionBoatFixture();
  expect(await runProductionBoat(productionBoatEnv, filtered.io, [...productionBoatArgs, "--feature", "exec"])).toBe(
    true,
  );
  expect(filtered.calls.map((call) => call.path)).not.toContain("sandbox/send");
  expect(filtered.calls.map((call) => call.path)).toContain("sandbox/exec");
  expect(filtered.calls.map((call) => call.path)).toContain("sandbox/delete");
  expect(filtered.journalWrites()).toBe(0);
});

// Fake time crosses the old 120-read ceiling without sleeping or real compute.
for (const fault of ["slow_turn", "turn_timeout", "stop_settling", "late_success", "deadline_exhausted"] as const) {
  test(`parity turn observation and terminal cleanup: ${fault}`, async () => {
    const fake = productionBoatFixture(fault);
    const passed = await runProductionBoat(productionBoatEnv, fake.io, [...productionBoatArgs, "--feature", "send"]);
    expect(passed).toBe(!["turn_timeout", "late_success", "deadline_exhausted"].includes(fault));
    const report = JSON.parse(fake.lines.find((line) => line.startsWith('{"step":"provider_parity"')) ?? "{}");
    expect(report.features.cleanup.boat.status).toBe("pass");
    const cleanup = JSON.parse(fake.lines.find((line) => line.startsWith('{"step":"parity_cleanup"')) ?? "{}");
    expect(cleanup.deleted).toBe(true);
    if (fault === "slow_turn") {
      const timing = JSON.parse(fake.lines.find((line) => line.startsWith('{"step":"parity_turn"')) ?? "{}");
      expect(timing.polls).toBe(131);
      expect(timing.serverElapsedMs).toBe(180_000);
      expect(timing.elapsedMs).toBeGreaterThan(180_000);
    } else if (fault === "turn_timeout") {
      expect(report.features.send.boat.diagnostic).toMatchObject({
        code: "poll_limit_exceeded",
        polls: 200,
        elapsedMs: 600_000,
        serverElapsedMs: null,
      });
      expect(fake.lines.at(-1)).toContain("polls=200");
      expect(fake.lines.at(-1)).toContain("elapsedMs=600000");
    } else if (fault === "late_success" || fault === "deadline_exhausted") {
      expect(report.features.send.boat.diagnostic.code).toBe("poll_limit_exceeded");
      expect(report.features.send.boat.diagnostic.polls).toBe(fault === "late_success" ? 1 : 0);
    } else {
      const paths = fake.calls.map((call) => call.path);
      const firstDelete = paths.indexOf("sandbox/delete");
      expect(paths[firstDelete - 1]).toBe("sandbox/status");
      expect(paths.filter((path) => path === "sandbox/delete")).toHaveLength(3);
      expect(paths.filter((path) => path === "sandbox/stop")).toHaveLength(1);
      const requests = fake.calls.filter((call) => call.path === "sandbox/delete").map((call) => call.body.request_id);
      expect(new Set(requests).size).toBe(1);
    }
  });
}

test("GitHub parity uses the same probe for coordinator production Boat", async () => {
  const fake = productionBoatFixture();
  const env = {
    ...productionBoatEnv,
    ARMADA_SMOKE_CASES: JSON.stringify([{ ...productionBoatCase, githubRepository: "owner/private-fixture" }]),
  };
  expect(await runProductionBoat(env, fake.io, [...productionBoatArgs, "--feature", "github"])).toBe(true);
  const report = JSON.parse(fake.lines.find((line) => line.startsWith('{"step":"provider_parity"')) ?? "{}");
  expect(report.features.github.boat.status).toBe("pass");
  expect(report.features.cleanup.boat.status).toBe("pass");
  expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(1);
  expect(fake.calls.find((call) => call.path === "sandbox/exec")?.body.command).toContain("push --dry-run");
});

// Configuration failures must be actionable before allocating any real compute.
for (const [name, override, field] of [
  ["missing URL", { ARMADA_URL: undefined }, "ARMADA_URL"],
  ["missing token", { ARMADA_TOKEN: " " }, "ARMADA_TOKEN"],
  ["missing consent", { ARMADA_SMOKE: undefined }, "ARMADA_SMOKE"],
  ["malformed JSON", { ARMADA_SMOKE_CASES: '{"secret":"never-echo-this"' }, "ARMADA_SMOKE_CASES"],
  ["non-array", { ARMADA_SMOKE_CASES: "{}" }, "ARMADA_SMOKE_CASES"],
  ["non-object", { ARMADA_SMOKE_CASES: "[null]" }, "ARMADA_SMOKE_CASES[0]"],
  [
    "unrecognized skip reason",
    {
      ARMADA_SMOKE_CASES:
        '[{"provider":"modal","account":"codex-azure","harness":"codex","notRunReason":"never-echo-this"}]',
    },
    "ARMADA_SMOKE_CASES[0].notRunReason",
  ],
  [
    "missing model without explicit metadata skip",
    { ARMADA_SMOKE_CASES: '[{"provider":"modal","account":"codex-azure","harness":"codex"}]' },
    "ARMADA_SMOKE_CASES[0].model",
  ],
  [
    "normal case without label",
    { ARMADA_SMOKE_CASES: '[{"provider":"boat"},{"provider":"modal"}]' },
    "ARMADA_SMOKE_CASES[1].account",
  ],
  [
    "wrong harness",
    { ARMADA_SMOKE_CASES: '[{"provider":"modal","account":"codex-openai","harness":"opencode"}]' },
    "ARMADA_SMOKE_CASES[0].harness",
  ],
  [
    "missing Docker host",
    {
      ARMADA_SMOKE_CASES:
        '[{"provider":"docker","account":"codex-openai","harness":"codex","org":"org","model":"model","modelAccountId":"account"}]',
    },
    "ARMADA_SMOKE_CASES[0].hostId",
  ],
] as const) {
  test(`accounts configuration identifies ${name}`, async () => {
    const lines: string[] = [];
    expect(
      await postDeploySmoke(
        Object.assign(
          {
            ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
            ARMADA_TOKEN: "never-echo-this",
            ARMADA_SMOKE: "create_real_compute",
            ARMADA_SMOKE_CASES: "[]",
          },
          override,
        ),
        ["--parity", "--accounts"],
        {
          now: () => 0,
          sleep: async () => {},
          out: (line) => lines.push(line),
          fetch: async () => {
            throw new Error("must not allocate or call the network on invalid configuration");
          },
        },
      ),
    ).toBe(false);
    expect(JSON.parse(lines.find((line) => line.startsWith("{"))!)).toMatchObject({
      code: "invalid_accounts_configuration",
      field,
      message: expect.any(String),
    });
    expect(lines.join("\n")).not.toContain("never-echo-this");
  });
}

test("accounts appends both human-readable tables to the Actions summary without allocating absent cells", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "armada-accounts-table-"));
  const summaryFile = join(root, "summary.md");
  const lines: string[] = [];
  try {
    expect(
      await postDeploySmoke(
        {
          ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
          ARMADA_TOKEN: "fixture-token",
          ARMADA_SMOKE: "create_real_compute",
          ARMADA_SMOKE_CASES: "[]",
          GITHUB_STEP_SUMMARY: summaryFile,
        },
        ["--parity", "--accounts"],
        {
          now: () => 0,
          sleep: async () => {},
          out: (line) => lines.push(line),
          fetch: async () => {
            throw Error("absent accounts must not allocate");
          },
        },
      ),
    ).toBe(true);
    const summary = await readFile(summaryFile, "utf8");
    expect(summary.match(/## Accounts parity/g)).toHaveLength(1);
    expect(summary.match(/## Account feature and cost details/g)).toHaveLength(1);
    expect(summary).toContain("| codex-subscription | docker | all | not-run: no account on staging |");
    expect(summary).not.toContain("USD 0");
    expect(lines.some((line) => line.startsWith("## Accounts parity"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
