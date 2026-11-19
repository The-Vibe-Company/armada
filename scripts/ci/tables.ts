// Map table families to the modules responsible for their writes. Keep lifecycle
// ownership narrow so provider, runtime and access code converge on that entry point.
const core = "packages/core/src";
const server = "packages/mcp-server/src";
const actions = "apps/dashboard/src/app/actions";

const owners = [
  [
    "sandboxes sandbox_transitions",
    [`${core}/sandbox.ts`, `${server}/sandbox-lifecycle.ts`, `${server}/sandbox-finish.ts`],
  ],
  ["triggers trigger_deliveries", [`${server}/inbound-trigger-store.ts`]],
  ["jobs", [`${server}/jobs/store.ts`]],
  ["runtime_resumes", [`${server}/runtime-resume.ts`, `${server}/sandbox-lifecycle.ts`]],
  ["runtime_*", [`${server}/runtime-*.ts`]],
  ["docker_*", [`${server}/docker-*.ts`]],
  ["model_auth_* account_*", [`${server}/account-*.ts`, `${server}/model-auth*.ts`]],
  ["sandbox_launch_stages", [`${core}/launch-stages.ts`, `${server}/launch-stage-record.ts`]],
  ["sandbox_output*", [`${server}/sandbox-outputs.ts`, `${server}/output-transfers.ts`]],
  ["sandbox_*_pricing sandbox_turn_models", [`${core}/sandbox.ts`, `${server}/turn-pricing.ts`]],
  ["sandbox_work_recovery", [`${server}/work-preservation.ts`]],
  [
    "provider_launch_requests ordinary_launch_receipts native_*",
    [`${server}/ordinary-launch-receipts.ts`, `${server}/native-*.ts`, `${server}/provider-*.ts`],
  ],
  ["goldens golden_*", [`${core}/golden-*.ts`, `${server}/golden-*.ts`]],
  ["*_skill_defaults", [`${core}/skill-defaults.ts`]],
  ["launch_templates launch_template_revisions template_launch_requests", [`${core}/template-service.ts`]],
  ["routines routine_*", [`${core}/routine-*.ts`]],
  [
    "application_secret* application_vault_audit readable_variables",
    [`${core}/application-vault.ts`, `${core}/readable-variables*.ts`],
  ],
  [
    "armada_access_parents orchestrator_* orchestrators",
    [`${core}/delegated-authority.ts`, `${server}/sandbox-access-*.ts`, `${server}/sandbox-armada-access.ts`],
  ],
  ["mcp_tokens oauth_* service_tokens", ["packages/auth/src/*.ts", `${server}/token-control.ts`]],
  ["mcp_*", [`${core}/connections.ts`, `${server}/mcp-*.ts`]],
  ["github_*", [`${server}/github-*.ts`, `${core}/github-*.ts`]],
  ["credentials agent_defaults", [`${core}/vault-store.ts`, `${actions}/credentials.ts`]],
  [
    "orgs members organization_invitations",
    [`${core}/vault-store.ts`, `${server}/invitations.ts`, `${actions}/orgs.ts`],
  ],
  ["modal_*", [`${server}/modal-*.ts`, "packages/provider-modal/src/**/*.ts"]],
  ["org_langfuse* langfuse_*", [`${server}/langfuse.ts`]],
  [
    "outbound_webhook_* notify_subscriptions",
    [`${server}/outbound-webhooks.ts`, `${server}/native-webhook-prompts.ts`],
  ],
  ["resource_observations", [`${server}/resource-store.ts`]],
] as const;

const rules = owners.map(([tables, paths]) => ({
  tables: tables
    .trim()
    .split(" ")
    .map((table) => new Bun.Glob(table)),
  paths,
  files: paths.map((path) => new Bun.Glob(path)),
}));

export function tableOwner(table: string) {
  return rules.find(({ tables }) => tables.some((pattern) => pattern.match(table)));
}
