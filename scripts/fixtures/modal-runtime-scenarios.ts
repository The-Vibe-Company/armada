export type Defect =
  | "opencode-shell-old"
  | "bad-checkpoint"
  | "claude-mcp-wrong-result-id"
  | "claude-old-version"
  | "disabled"
  | "empty-bad-checkpoint"
  | "empty-disk-mismatch"
  | "empty-hidden-history"
  | "empty-lost-first-send"
  | "empty-missing-proof"
  | "empty-old-version"
  | "empty-stop-unknown"
  | "empty-wrong-epoch"
  | "empty-wrong-watermark"
  | "github-echo-mask"
  | "github-missing-tool"
  | "github-no-acquisition"
  | "github-old-preflight"
  | "github-resume-old-config"
  | "github-resume-reused-revision"
  | "github-stale-revision"
  | "github-wrapper"
  | "github-wrong-epoch"
  | "github-wrong-output"
  | "idle-bad-receipt"
  | "idle-lost-first-send"
  | "idle-old-version"
  | "idle-running-history"
  | "idle-template-active-conversation"
  | "idle-template-foreign-status"
  | "idle-template-old-version"
  | "idle-template-wrong-status"
  | "idle-wrong-first-conversation"
  | "idle-wrong-first-epoch"
  | "idle-wrong-first-request"
  | "lost-followup"
  | "lost-launch"
  | "mcp-error-result"
  | "mcp-no-result"
  | "mcp-old-prompt"
  | "mcp-old-version"
  | "mcp-preflight-denied"
  | "mcp-resume-replay"
  | "mcp-wrong-args"
  | "mcp-wrong-output"
  | "mcp-wrong-server"
  | "mcp-wrong-tool"
  | "old-followup"
  | "old-resume"
  | "opencode-github-display-only"
  | "opencode-mcp-collision"
  | "opencode-mcp-display-only"
  | "opencode-mcp-duplicate-name"
  | "opencode-mcp-inventory-drift"
  | "opencode-mcp-inventory-missing"
  | "opencode-mcp-old-version"
  | "opencode-old-version"
  | "opencode-variables-bad-exit"
  | "opencode-variables-truncated"
  | "ordinary-default-off"
  | "ordinary-missing-transport"
  | "ordinary-template-missing-transport"
  | "replayed-answer"
  | "resume-bad-checkpoint"
  | "resume-bad-epoch"
  | "resume-empty-checkpoint"
  | "resume-lost"
  | "resume-lost-old-history"
  | "resume-lost-stopped-history"
  | "resume-not-resumed"
  | "resume-reused-prompt"
  | "resume-stop-unknown"
  | "resume-tool-result"
  | "resume-wrong-conversation"
  | "resume-wrong-request"
  | "resume-wrong-source"
  | "resume-wrong-watermark"
  | "reused-prompt"
  | "skills-empty"
  | "skills-missing-launch"
  | "skills-old-version"
  | "skills-resume-status-mismatch"
  | "skills-resume-stop-status-mismatch"
  | "skills-status-mismatch"
  | "skills-wrong-golden"
  | "stale-epoch"
  | "tool-result"
  | "usage-extra-observation"
  | "usage-forged-cost"
  | "usage-forged-guest-money"
  | "usage-late"
  | "usage-missing-facts"
  | "usage-no-admission"
  | "usage-old-version"
  | "usage-resume-repricing"
  | "usage-resume-stopped-drift"
  | "usage-stopped-drift"
  | "usage-unknown"
  | "usage-wrong-account"
  | "usage-wrong-model"
  | "usage-wrong-totals"
  | "usage-zero-missing"
  | "variables-echo-mask"
  | "variables-missing-env"
  | "variables-missing-vars"
  | "variables-no-tool"
  | "variables-old-prompt"
  | "variables-old-version"
  | "variables-receipt-mismatch"
  | "variables-resume-replay"
  | "variables-secrets"
  | "variables-wrapper"
  | "variables-wrong-account"
  | "variables-wrong-golden"
  | "variables-wrong-hash"
  | "variables-wrong-keys"
  | "variables-wrong-template"
  | "wrong-conversation"
  | "wrong-prompt"
  | "wrong-request"
  | "wrong-source";
export type CliFlag =
  | "--resume"
  | "--ordinary"
  | "--idle"
  | "--empty-resume"
  | "--claude"
  | "--opencode"
  | "--github"
  | "--mcp"
  | "--skills"
  | "--variables"
  | "--usage";
export interface Expected {
  success: boolean;
  counters: { launches: number; stops: number; checkpoints: number; resumes: number; sends: number };
  firstSends?: number;
  diskWrites?: number;
  diskReads?: number;
  skillStatuses?: number;
  defaultReads?: number;
  goldenReads?: number;
  adjustedSkillStatuses?: number;
  stdoutContains?: string[];
  stdoutExcludes?: string[];
  stderrContains?: string[];
  stderrExcludes?: string[];
  combinedContains?: string[];
  combinedExcludes?: string[];
  proofs: Record<string, boolean>;
}
export interface Scenario {
  label: string;
  args: CliFlag[];
  defects: Defect[];
  expected: Expected;
  invalidMcpArgs?: boolean;
}

const expected = {
  success: {
    success: true,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  ordinary: {
    stdoutContains: [
      '"ordinaryDefault":"verified"',
      '"answer":"verified"',
      '"checkpoint":"verified"',
      '"followup":"verified"',
      "compute stopped",
    ],
    success: true,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  ordinaryResume: {
    stdoutContains: [
      '"ordinaryDefault":"verified"',
      '"answer":"verified"',
      '"checkpoint":"verified"',
      '"followup":"verified"',
      "compute stopped",
    ],
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: true,
      githubAfterResume: false,
    },
  },
  ordinaryVariables: {
    stdoutContains: [
      '"ordinaryDefault":"verified"',
      '"answer":"verified"',
      '"checkpoint":"verified"',
      '"followup":"verified"',
      "compute stopped",
    ],
    success: true,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    proofs: {
      resume: false,
      githubAfterResume: false,
      variables: true,
      variablesAfterResume: false,
    },
  },
  ordinaryIdleVariables: {
    stdoutContains: [
      '"ordinaryDefault":"verified"',
      '"answer":"verified"',
      '"checkpoint":"verified"',
      '"followup":"verified"',
      "compute stopped",
    ],
    firstSends: 1,
    success: true,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    proofs: {
      resume: false,
      githubAfterResume: false,
      variables: true,
      variablesAfterResume: false,
    },
  },
  ordinaryEmpty: {
    stdoutContains: [
      '"ordinaryDefault":"verified"',
      '"emptyResume":"verified"',
      '"retainedFile":"verified"',
      '"answer":"verified"',
      '"checkpoint":"verified"',
      '"followup":"verified"',
      "compute stopped",
    ],
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    firstSends: 1,
    diskWrites: 1,
    diskReads: 1,
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  ordinaryUsageVariablesSkillsMcpGithubResume: {
    stdoutContains: [
      '"ordinaryDefault":"verified"',
      '"answer":"verified"',
      '"checkpoint":"verified"',
      '"followup":"verified"',
      "compute stopped",
    ],
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 2,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    proofs: {
      resume: true,
      github: true,
      githubAfterResume: true,
      usage: true,
      usageAfterResume: true,
      variables: true,
      variablesAfterResume: true,
      skills: true,
      skillsAfterResume: true,
      mcp: true,
      mcpAfterResume: true,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 14,
  },
  ordinaryDefaultOff: {
    stderrContains: ["Ordinary Modal default is not dial-out"],
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  ordinaryMissingTransport: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  ordinaryTemplateMissingTransport: {
    stderrContains: ["Missing Modal enrolled launch acknowledgement"],
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      variables: false,
      variablesAfterResume: false,
    },
  },
  emptySuccess: {
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    firstSends: 1,
    diskWrites: 1,
    diskReads: 1,
    stdoutContains: [
      '"emptyResume":"verified"',
      '"retainedFile":"verified"',
      '"answer":"verified"',
      '"checkpoint":"verified"',
      '"followup":"verified"',
      "compute stopped",
    ],
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  emptyVariables: {
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    firstSends: 1,
    diskWrites: 1,
    diskReads: 1,
    stdoutContains: [
      '"emptyResume":"verified"',
      '"retainedFile":"verified"',
      '"answer":"verified"',
      '"checkpoint":"verified"',
      '"followup":"verified"',
      "compute stopped",
    ],
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    proofs: {
      resume: false,
      githubAfterResume: false,
      variables: true,
      variablesAfterResume: false,
    },
  },
  emptySkills: {
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    firstSends: 1,
    diskWrites: 1,
    diskReads: 1,
    stdoutContains: [
      '"emptyResume":"verified"',
      '"retainedFile":"verified"',
      '"answer":"verified"',
      '"checkpoint":"verified"',
      '"followup":"verified"',
      "compute stopped",
    ],
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
      skills: true,
      skillsAfterResume: false,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 3,
  },
  emptyCombined: {
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    firstSends: 1,
    diskWrites: 1,
    diskReads: 1,
    stdoutContains: [
      '"emptyResume":"verified"',
      '"retainedFile":"verified"',
      '"answer":"verified"',
      '"checkpoint":"verified"',
      '"followup":"verified"',
      "compute stopped",
    ],
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    proofs: {
      resume: false,
      github: true,
      githubAfterResume: false,
      usage: true,
      usageAfterResume: false,
      variables: true,
      variablesAfterResume: false,
      skills: true,
      skillsAfterResume: false,
      mcp: true,
      mcpAfterResume: false,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 6,
  },
  emptyOldVersion: {
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    firstSends: 0,
    diskWrites: 0,
    diskReads: 0,
    stdoutExcludes: ['"emptyResume":"verified"', '"answer":"verified"'],
    stderrContains: ["Modal empty-checkpoint resume v1 is unavailable"],
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  emptyTwoActivations: {
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    firstSends: 0,
    diskWrites: 0,
    diskReads: 0,
    stdoutExcludes: ['"emptyResume":"verified"', '"answer":"verified"'],
    stderrContains: ["Select one retained activation mode"],
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  emptyBadCheckpoint: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 0,
    },
    firstSends: 0,
    diskWrites: 1,
    diskReads: 0,
    stdoutExcludes: ['"emptyResume":"verified"', '"answer":"verified"'],
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  emptyHiddenHistory: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 2,
      resumes: 0,
      sends: 0,
    },
    firstSends: 0,
    diskWrites: 1,
    diskReads: 0,
    stdoutExcludes: ['"emptyResume":"verified"', '"answer":"verified"'],
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  emptyLostFirstSend: {
    success: false,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 2,
      resumes: 1,
      sends: 0,
    },
    firstSends: 1,
    diskWrites: 1,
    diskReads: 0,
    stdoutExcludes: ['"emptyResume":"verified"', '"answer":"verified"'],
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  emptyDiskMismatch: {
    success: false,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 2,
      resumes: 1,
      sends: 0,
    },
    firstSends: 1,
    diskWrites: 1,
    diskReads: 1,
    stdoutExcludes: ['"emptyResume":"verified"', '"answer":"verified"'],
    stderrContains: ["did not preserve the file witness"],
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  idle: {
    firstSends: 1,
    success: true,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  idleResume: {
    firstSends: 1,
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: true,
      githubAfterResume: false,
    },
  },
  idleVariables: {
    firstSends: 1,
    success: true,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: false,
      githubAfterResume: false,
      variables: true,
      variablesAfterResume: false,
    },
  },
  idleVariablesResume: {
    firstSends: 1,
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: true,
      githubAfterResume: false,
      variables: true,
      variablesAfterResume: true,
    },
  },
  idleUsageVariablesSkillsMcpGithubResume: {
    firstSends: 1,
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 2,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: true,
      github: true,
      githubAfterResume: true,
      usage: true,
      usageAfterResume: true,
      variables: true,
      variablesAfterResume: true,
      skills: true,
      skillsAfterResume: true,
      mcp: true,
      mcpAfterResume: true,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 14,
  },
  idleTemplateWrongStatus: {
    firstSends: 0,
    stderrContains: ["Promptless template current status is not empty"],
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      variables: false,
      variablesAfterResume: false,
    },
  },
  idleOldVersion: {
    firstSends: 0,
    stderrContains: ["Modal promptless launch/first-send v1 is unavailable"],
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  idleBadReceipt: {
    firstSends: 0,
    stderrContains: ["Idle Modal launch did not publish"],
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  idleRunningHistory: {
    firstSends: 0,
    stderrContains: ["Idle archive already contains inference"],
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  idleLostFirstSend: {
    firstSends: 1,
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  idleTemplateOldVersion: {
    firstSends: 0,
    stderrContains: ["Modal promptless template v1 is unavailable"],
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      variables: false,
      variablesAfterResume: false,
    },
  },
  opencodeResume: {
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: true,
      githubAfterResume: false,
    },
  },
  opencodeMcp: {
    success: true,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: false,
      githubAfterResume: false,
      mcp: true,
      mcpAfterResume: false,
    },
  },
  opencodeMcpResume: {
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: true,
      githubAfterResume: false,
      mcp: true,
      mcpAfterResume: true,
    },
  },
  opencodeUsageVariablesSkillsMcpGithubResume: {
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 2,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: true,
      github: true,
      githubAfterResume: true,
      usage: true,
      usageAfterResume: true,
      variables: true,
      variablesAfterResume: true,
      skills: true,
      skillsAfterResume: true,
      mcp: true,
      mcpAfterResume: true,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 14,
  },
  opencodeMcpNoResult: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      mcp: false,
      mcpAfterResume: false,
    },
  },
  opencodeMcpResumeReplay: {
    success: false,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 2,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
      mcp: true,
      mcpAfterResume: false,
    },
  },
  opencodeMcpCollision: {
    stderrContains: ["missing or ambiguous"],
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      mcp: false,
      mcpAfterResume: false,
    },
  },
  opencodeMcpInventoryMissing: {
    stderrContains: ["Complete authorized OpenCode MCP tool inventory is unavailable"],
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      mcp: false,
      mcpAfterResume: false,
    },
  },
  opencodeMcpInventoryDrift: {
    stderrContains: ["inventory changed"],
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      mcp: false,
      mcpAfterResume: false,
    },
  },
  opencodeGithub: {
    success: true,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: false,
      github: true,
      githubAfterResume: false,
    },
  },
  opencodeGithubResume: {
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 2,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: true,
      github: true,
      githubAfterResume: true,
    },
  },
  opencodeVariables: {
    success: true,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: false,
      githubAfterResume: false,
      variables: true,
      variablesAfterResume: false,
    },
  },
  opencodeVariablesResume: {
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: true,
      githubAfterResume: false,
      variables: true,
      variablesAfterResume: true,
    },
  },
  opencodeUsageVariablesSkillsGithubResume: {
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 2,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: true,
      github: true,
      githubAfterResume: true,
      usage: true,
      usageAfterResume: true,
      variables: true,
      variablesAfterResume: true,
      skills: true,
      skillsAfterResume: true,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 14,
  },
  opencodeGithubDisplayOnly: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      github: false,
      githubAfterResume: false,
    },
  },
  opencodeVariablesOldPrompt: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      variables: false,
      variablesAfterResume: false,
    },
  },
  opencodeShellOld: {
    stderrContains: ["OpenCode native shell proof v1 is unavailable"],
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  opencodeUsage: {
    success: true,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: false,
      githubAfterResume: false,
      usage: true,
      usageAfterResume: false,
    },
  },
  opencodeSkillsResume: {
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: true,
      githubAfterResume: false,
      skills: true,
      skillsAfterResume: true,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 4,
  },
  opencodeOldVersion: {
    stderrContains: ["Modal enrolled OpenCode v1 is unavailable"],
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  opencodeMcpOldVersion: {
    stderrContains: ["OpenCode native MCP proof v1 is unavailable"],
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      mcp: false,
      mcpAfterResume: false,
    },
  },
  opencodeClaudeConflict: {
    stderrContains: ["Select only one harness"],
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  claudeOldVersion: {
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  claudeVariablesSkillsMcpGithubResume: {
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 2,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: true,
      github: true,
      githubAfterResume: true,
      variables: true,
      variablesAfterResume: true,
      skills: true,
      skillsAfterResume: true,
      mcp: true,
      mcpAfterResume: true,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 4,
  },
  badCheckpoint: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  lostLaunch: {
    success: false,
    counters: {
      launches: 1,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  lostFollowup: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  resumeBadEpoch: {
    success: false,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 2,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  resumeLostStoppedHistory: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 2,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  resumeBadCheckpoint: {
    success: false,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
    },
  },
  githubOldPreflight: {
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      github: false,
      githubAfterResume: false,
    },
  },
  githubWrongEpoch: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      github: false,
      githubAfterResume: false,
    },
  },
  githubResumeOldConfig: {
    success: false,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 2,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      github: true,
      githubAfterResume: false,
    },
  },
  mcpGithubResume: {
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 2,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: true,
      github: true,
      githubAfterResume: true,
      mcp: true,
      mcpAfterResume: true,
    },
  },
  mcpOldVersion: {
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      mcp: false,
      mcpAfterResume: false,
    },
  },
  skills: {
    success: true,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: false,
      githubAfterResume: false,
      skills: true,
      skillsAfterResume: false,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 2,
  },
  skillsEmpty: {
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      skills: false,
      skillsAfterResume: false,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 0,
    stderrContains: ["No default skills configured"],
  },
  skillsOldVersion: {
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      skills: false,
      skillsAfterResume: false,
    },
    defaultReads: 0,
    goldenReads: 0,
    adjustedSkillStatuses: 0,
  },
  skillsMissingLaunch: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      skills: false,
      skillsAfterResume: false,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 2,
  },
  skillsWrongGolden: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      skills: false,
      skillsAfterResume: false,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 1,
  },
  skillsResumeStatusMismatch: {
    success: false,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 2,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
      skills: true,
      skillsAfterResume: false,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 4,
  },
  skillsResumeStopStatusMismatch: {
    success: false,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
      skills: true,
      skillsAfterResume: false,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 4,
  },
  skillsMcpGithubResume: {
    success: true,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 2,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutContains: ['"answer":"verified"', '"checkpoint":"verified"', '"followup":"verified"', "compute stopped"],
    proofs: {
      resume: true,
      github: true,
      githubAfterResume: true,
      skills: true,
      skillsAfterResume: true,
      mcp: true,
      mcpAfterResume: true,
    },
    defaultReads: 3,
    goldenReads: 1,
    adjustedSkillStatuses: 4,
  },
  variablesOldVersion: {
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      variables: false,
      variablesAfterResume: false,
    },
  },
  variablesResumeReplay: {
    success: false,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 2,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: [
      "fixture-token",
      "private transport diagnostics",
      "87695aff52e6ddfeec827188ef0d53e36cad584439ca428b5bffedfe4171ec6b",
      "readable-canary\n$(not-a-command)",
    ],
    proofs: {
      resume: false,
      githubAfterResume: false,
      variables: true,
      variablesAfterResume: false,
    },
  },
  usageUnknown: {
    success: true,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutContains: [
      '"answer":"verified"',
      '"checkpoint":"verified"',
      '"followup":"verified"',
      "compute stopped",
      '"status":"unknown"',
    ],
    proofs: {
      resume: false,
      githubAfterResume: false,
      usage: true,
      usageAfterResume: false,
    },
  },
  usageOldVersion: {
    success: false,
    counters: {
      launches: 0,
      stops: 0,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      usage: false,
      usageAfterResume: false,
    },
    skillStatuses: 0,
  },
  usageMissingFacts: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      usage: false,
      usageAfterResume: false,
    },
    skillStatuses: 0,
  },
  usageWrongTotals: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 0,
      resumes: 0,
      sends: 0,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    stdoutExcludes: ['"answer":"verified"'],
    proofs: {
      resume: false,
      githubAfterResume: false,
      usage: false,
      usageAfterResume: false,
    },
  },
  usageStoppedDrift: {
    success: false,
    counters: {
      launches: 1,
      stops: 1,
      checkpoints: 1,
      resumes: 0,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
      usage: true,
      usageAfterResume: false,
    },
  },
  usageResumeRepricing: {
    success: false,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 2,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
      usage: true,
      usageAfterResume: false,
    },
  },
  usageResumeStoppedDrift: {
    success: false,
    counters: {
      launches: 1,
      stops: 2,
      checkpoints: 3,
      resumes: 1,
      sends: 1,
    },
    combinedExcludes: ["fixture-token", "private transport diagnostics"],
    proofs: {
      resume: false,
      githubAfterResume: false,
      usage: true,
      usageAfterResume: false,
    },
  },
} satisfies Record<string, Expected>;

export const scenarios: Scenario[] = [
  { label: "success", args: [], defects: [], expected: expected.success },
  { label: "ordinary", args: ["--ordinary"], defects: [], expected: expected.ordinary },
  { label: "ordinary-resume", args: ["--resume", "--ordinary"], defects: [], expected: expected.ordinaryResume },
  { label: "ordinary-claude", args: ["--ordinary", "--claude"], defects: [], expected: expected.ordinary },
  { label: "ordinary-opencode", args: ["--ordinary", "--opencode"], defects: [], expected: expected.ordinary },
  {
    label: "ordinary-variables",
    args: ["--ordinary", "--variables"],
    defects: [],
    expected: expected.ordinaryVariables,
  },
  {
    label: "ordinary-idle-variables",
    args: ["--ordinary", "--idle", "--variables"],
    defects: [],
    expected: expected.ordinaryIdleVariables,
  },
  { label: "ordinary-empty", args: ["--ordinary", "--empty-resume"], defects: [], expected: expected.ordinaryEmpty },
  {
    label: "ordinary-usage-variables-skills-mcp-github-resume",
    args: ["--resume", "--ordinary", "--github", "--mcp", "--skills", "--variables", "--usage"],
    defects: [],
    expected: expected.ordinaryUsageVariablesSkillsMcpGithubResume,
  },
  {
    label: "ordinary-default-off",
    args: ["--ordinary"],
    defects: ["old-followup", "ordinary-default-off"],
    expected: expected.ordinaryDefaultOff,
  },
  {
    label: "ordinary-missing-transport",
    args: ["--ordinary"],
    defects: ["wrong-source", "ordinary-missing-transport"],
    expected: expected.ordinaryMissingTransport,
  },
  {
    label: "ordinary-template-missing-transport",
    args: ["--ordinary", "--variables"],
    defects: ["variables-no-tool", "ordinary-template-missing-transport"],
    expected: expected.ordinaryTemplateMissingTransport,
  },
  { label: "empty-success", args: ["--empty-resume"], defects: [], expected: expected.emptySuccess },
  { label: "empty-claude", args: ["--empty-resume", "--claude"], defects: [], expected: expected.emptySuccess },
  { label: "empty-opencode", args: ["--empty-resume", "--opencode"], defects: [], expected: expected.emptySuccess },
  { label: "empty-variables", args: ["--empty-resume", "--variables"], defects: [], expected: expected.emptyVariables },
  { label: "empty-skills", args: ["--empty-resume", "--skills"], defects: [], expected: expected.emptySkills },
  {
    label: "empty-combined",
    args: ["--empty-resume", "--github", "--mcp", "--skills", "--variables", "--usage"],
    defects: [],
    expected: expected.emptyCombined,
  },
  {
    label: "empty-old-version",
    args: ["--empty-resume"],
    defects: ["old-followup", "empty-old-version"],
    expected: expected.emptyOldVersion,
  },
  {
    label: "empty-two-activations",
    args: ["--resume", "--empty-resume"],
    defects: ["old-followup"],
    expected: expected.emptyTwoActivations,
  },
  {
    label: "empty-bad-checkpoint",
    args: ["--empty-resume"],
    defects: ["tool-result", "empty-bad-checkpoint"],
    expected: expected.emptyBadCheckpoint,
  },
  {
    label: "empty-stop-unknown",
    args: ["--empty-resume"],
    defects: ["tool-result", "empty-stop-unknown"],
    expected: expected.emptyBadCheckpoint,
  },
  {
    label: "empty-hidden-history",
    args: ["--empty-resume"],
    defects: ["tool-result", "empty-hidden-history"],
    expected: expected.emptyHiddenHistory,
  },
  {
    label: "empty-lost-first-send",
    args: ["--empty-resume"],
    defects: ["tool-result", "empty-lost-first-send"],
    expected: expected.emptyLostFirstSend,
  },
  {
    label: "empty-wrong-epoch",
    args: ["--empty-resume"],
    defects: ["tool-result", "empty-wrong-epoch"],
    expected: expected.emptyLostFirstSend,
  },
  {
    label: "empty-missing-proof",
    args: ["--empty-resume"],
    defects: ["tool-result", "empty-missing-proof"],
    expected: expected.emptyLostFirstSend,
  },
  {
    label: "empty-wrong-watermark",
    args: ["--empty-resume"],
    defects: ["tool-result", "empty-wrong-watermark"],
    expected: expected.emptyLostFirstSend,
  },
  {
    label: "empty-disk-mismatch",
    args: ["--empty-resume"],
    defects: ["tool-result", "empty-disk-mismatch"],
    expected: expected.emptyDiskMismatch,
  },
  { label: "idle", args: ["--idle"], defects: [], expected: expected.idle },
  { label: "idle-resume", args: ["--resume", "--idle"], defects: [], expected: expected.idleResume },
  { label: "idle-variables", args: ["--idle", "--variables"], defects: [], expected: expected.idleVariables },
  {
    label: "idle-variables-resume",
    args: ["--resume", "--idle", "--variables"],
    defects: [],
    expected: expected.idleVariablesResume,
  },
  {
    label: "idle-usage-variables-skills-mcp-github-resume",
    args: ["--resume", "--idle", "--github", "--mcp", "--skills", "--variables", "--usage"],
    defects: [],
    expected: expected.idleUsageVariablesSkillsMcpGithubResume,
  },
  {
    label: "idle-template-wrong-status",
    args: ["--idle", "--variables"],
    defects: ["variables-no-tool", "idle-template-wrong-status"],
    expected: expected.idleTemplateWrongStatus,
  },
  {
    label: "idle-template-foreign-status",
    args: ["--idle", "--variables"],
    defects: ["variables-no-tool", "idle-template-foreign-status"],
    expected: expected.idleTemplateWrongStatus,
  },
  {
    label: "idle-template-active-conversation",
    args: ["--idle", "--variables"],
    defects: ["variables-no-tool", "idle-template-active-conversation"],
    expected: expected.idleTemplateWrongStatus,
  },
  { label: "idle-claude", args: ["--idle", "--claude"], defects: [], expected: expected.idle },
  { label: "idle-opencode", args: ["--idle", "--opencode"], defects: [], expected: expected.idle },
  {
    label: "idle-old-version",
    args: ["--idle"],
    defects: ["old-followup", "idle-old-version"],
    expected: expected.idleOldVersion,
  },
  {
    label: "idle-bad-receipt",
    args: ["--idle"],
    defects: ["tool-result", "idle-bad-receipt"],
    expected: expected.idleBadReceipt,
  },
  {
    label: "idle-running-history",
    args: ["--idle"],
    defects: ["tool-result", "idle-running-history"],
    expected: expected.idleRunningHistory,
  },
  {
    label: "idle-lost-first-send",
    args: ["--idle"],
    defects: ["tool-result", "idle-lost-first-send"],
    expected: expected.idleLostFirstSend,
  },
  {
    label: "idle-wrong-first-epoch",
    args: ["--idle"],
    defects: ["tool-result", "idle-wrong-first-epoch"],
    expected: expected.idleLostFirstSend,
  },
  {
    label: "idle-wrong-first-request",
    args: ["--idle"],
    defects: ["tool-result", "idle-wrong-first-request"],
    expected: expected.idleLostFirstSend,
  },
  {
    label: "idle-wrong-first-conversation",
    args: ["--idle"],
    defects: ["tool-result", "idle-wrong-first-conversation"],
    expected: expected.idleLostFirstSend,
  },
  {
    label: "idle-template-old-version",
    args: ["--idle", "--variables"],
    defects: ["variables-old-version", "idle-template-old-version"],
    expected: expected.idleTemplateOldVersion,
  },
  { label: "opencode", args: ["--opencode"], defects: [], expected: expected.success },
  { label: "opencode-resume", args: ["--resume", "--opencode"], defects: [], expected: expected.opencodeResume },
  { label: "opencode-mcp", args: ["--opencode", "--mcp"], defects: [], expected: expected.opencodeMcp },
  {
    label: "opencode-mcp-resume",
    args: ["--resume", "--opencode", "--mcp"],
    defects: [],
    expected: expected.opencodeMcpResume,
  },
  {
    label: "opencode-usage-variables-skills-mcp-github-resume",
    args: ["--resume", "--opencode", "--github", "--mcp", "--skills", "--variables", "--usage"],
    defects: [],
    expected: expected.opencodeUsageVariablesSkillsMcpGithubResume,
  },
  {
    label: "opencode-mcp-no-result",
    args: ["--opencode", "--mcp"],
    defects: ["mcp-no-result"],
    expected: expected.opencodeMcpNoResult,
  },
  {
    label: "opencode-mcp-error-result",
    args: ["--opencode", "--mcp"],
    defects: ["mcp-error-result"],
    expected: expected.opencodeMcpNoResult,
  },
  {
    label: "opencode-mcp-wrong-server",
    args: ["--opencode", "--mcp"],
    defects: ["mcp-wrong-server"],
    expected: expected.opencodeMcpNoResult,
  },
  {
    label: "opencode-mcp-wrong-tool",
    args: ["--opencode", "--mcp"],
    defects: ["mcp-wrong-tool"],
    expected: expected.opencodeMcpNoResult,
  },
  {
    label: "opencode-mcp-wrong-args",
    args: ["--opencode", "--mcp"],
    defects: ["mcp-wrong-args"],
    expected: expected.opencodeMcpNoResult,
  },
  {
    label: "opencode-mcp-old-prompt",
    args: ["--opencode", "--mcp"],
    defects: ["mcp-old-prompt"],
    expected: expected.opencodeMcpNoResult,
  },
  {
    label: "opencode-mcp-resume-replay",
    args: ["--resume", "--opencode", "--mcp"],
    defects: ["mcp-resume-replay"],
    expected: expected.opencodeMcpResumeReplay,
  },
  {
    label: "opencode-mcp-collision",
    args: ["--opencode", "--mcp"],
    defects: ["mcp-preflight-denied", "opencode-mcp-collision"],
    expected: expected.opencodeMcpCollision,
  },
  {
    label: "opencode-mcp-duplicate-name",
    args: ["--opencode", "--mcp"],
    defects: ["mcp-preflight-denied", "opencode-mcp-duplicate-name"],
    expected: expected.opencodeMcpCollision,
  },
  {
    label: "opencode-mcp-inventory-missing",
    args: ["--opencode", "--mcp"],
    defects: ["mcp-preflight-denied", "opencode-mcp-inventory-missing"],
    expected: expected.opencodeMcpInventoryMissing,
  },
  {
    label: "opencode-mcp-inventory-drift",
    args: ["--opencode", "--mcp"],
    defects: ["mcp-no-result", "opencode-mcp-inventory-drift"],
    expected: expected.opencodeMcpInventoryDrift,
  },
  {
    label: "opencode-mcp-display-only",
    args: ["--opencode", "--mcp"],
    defects: ["mcp-no-result", "opencode-mcp-display-only"],
    expected: expected.opencodeMcpNoResult,
  },
  { label: "opencode-github", args: ["--opencode", "--github"], defects: [], expected: expected.opencodeGithub },
  {
    label: "opencode-github-resume",
    args: ["--resume", "--opencode", "--github"],
    defects: [],
    expected: expected.opencodeGithubResume,
  },
  {
    label: "opencode-variables",
    args: ["--opencode", "--variables"],
    defects: [],
    expected: expected.opencodeVariables,
  },
  {
    label: "opencode-variables-resume",
    args: ["--resume", "--opencode", "--variables"],
    defects: [],
    expected: expected.opencodeVariablesResume,
  },
  {
    label: "opencode-usage-variables-skills-github-resume",
    args: ["--resume", "--opencode", "--github", "--skills", "--variables", "--usage"],
    defects: [],
    expected: expected.opencodeUsageVariablesSkillsGithubResume,
  },
  {
    label: "opencode-github-display-only",
    args: ["--opencode", "--github"],
    defects: ["github-missing-tool", "opencode-github-display-only"],
    expected: expected.opencodeGithubDisplayOnly,
  },
  {
    label: "opencode-github-wrong-output",
    args: ["--opencode", "--github"],
    defects: ["github-wrong-output"],
    expected: expected.opencodeGithubDisplayOnly,
  },
  {
    label: "opencode-variables-old-prompt",
    args: ["--opencode", "--variables"],
    defects: ["variables-old-prompt"],
    expected: expected.opencodeVariablesOldPrompt,
  },
  {
    label: "opencode-variables-echo-mask",
    args: ["--opencode", "--variables"],
    defects: ["variables-echo-mask"],
    expected: expected.opencodeVariablesOldPrompt,
  },
  {
    label: "opencode-variables-bad-exit",
    args: ["--opencode", "--variables"],
    defects: ["variables-wrong-hash", "opencode-variables-bad-exit"],
    expected: expected.opencodeVariablesOldPrompt,
  },
  {
    label: "opencode-variables-truncated",
    args: ["--opencode", "--variables"],
    defects: ["variables-wrong-hash", "opencode-variables-truncated"],
    expected: expected.opencodeVariablesOldPrompt,
  },
  {
    label: "opencode-shell-old",
    args: ["--opencode", "--github"],
    defects: ["old-followup", "opencode-shell-old"],
    expected: expected.opencodeShellOld,
  },
  { label: "opencode-usage", args: ["--opencode", "--usage"], defects: [], expected: expected.opencodeUsage },
  {
    label: "opencode-skills-resume",
    args: ["--resume", "--opencode", "--skills"],
    defects: [],
    expected: expected.opencodeSkillsResume,
  },
  {
    label: "opencode-old-version",
    args: ["--opencode"],
    defects: ["old-followup", "opencode-old-version"],
    expected: expected.opencodeOldVersion,
  },
  {
    label: "opencode-mcp-old-version",
    args: ["--opencode", "--mcp"],
    defects: ["mcp-old-version", "opencode-mcp-old-version"],
    expected: expected.opencodeMcpOldVersion,
  },
  {
    label: "opencode-claude-conflict",
    args: ["--claude", "--opencode"],
    defects: ["old-followup"],
    expected: expected.opencodeClaudeConflict,
  },
  { label: "claude", args: ["--claude"], defects: [], expected: expected.success },
  { label: "claude-resume", args: ["--resume", "--claude"], defects: [], expected: expected.opencodeResume },
  {
    label: "claude-old-version",
    args: ["--claude"],
    defects: ["old-followup", "claude-old-version"],
    expected: expected.claudeOldVersion,
  },
  {
    label: "claude-variables-skills-mcp-github-resume",
    args: ["--resume", "--claude", "--github", "--mcp", "--skills", "--variables"],
    defects: [],
    expected: expected.claudeVariablesSkillsMcpGithubResume,
  },
  {
    label: "claude-mcp-wrong-server",
    args: ["--claude", "--mcp"],
    defects: ["mcp-wrong-server"],
    expected: expected.opencodeMcpNoResult,
  },
  {
    label: "claude-mcp-no-result",
    args: ["--claude", "--mcp"],
    defects: ["mcp-no-result"],
    expected: expected.opencodeMcpNoResult,
  },
  {
    label: "claude-mcp-wrong-result-id",
    args: ["--claude", "--mcp"],
    defects: ["mcp-no-result", "claude-mcp-wrong-result-id"],
    expected: expected.opencodeMcpNoResult,
  },
  {
    label: "claude-mcp-error-result",
    args: ["--claude", "--mcp"],
    defects: ["mcp-error-result"],
    expected: expected.opencodeMcpNoResult,
  },
  {
    label: "claude-variables-old-prompt",
    args: ["--claude", "--variables"],
    defects: ["variables-old-prompt"],
    expected: expected.opencodeVariablesOldPrompt,
  },
  {
    label: "claude-github-wrong-output",
    args: ["--claude", "--github"],
    defects: ["github-wrong-output"],
    expected: expected.opencodeGithubDisplayOnly,
  },
  { label: "disabled", args: [], defects: ["disabled"], expected: expected.claudeOldVersion },
  { label: "old-followup", args: [], defects: ["old-followup"], expected: expected.claudeOldVersion },
  { label: "wrong-source", args: [], defects: ["wrong-source"], expected: expected.ordinaryMissingTransport },
  { label: "wrong-prompt", args: [], defects: ["wrong-prompt"], expected: expected.ordinaryMissingTransport },
  { label: "tool-result", args: [], defects: ["tool-result"], expected: expected.ordinaryMissingTransport },
  { label: "bad-checkpoint", args: [], defects: ["bad-checkpoint"], expected: expected.badCheckpoint },
  { label: "lost-launch", args: [], defects: ["lost-launch"], expected: expected.lostLaunch },
  { label: "lost-followup", args: [], defects: ["lost-followup"], expected: expected.lostFollowup },
  { label: "stale-epoch", args: [], defects: ["stale-epoch"], expected: expected.lostFollowup },
  { label: "wrong-conversation", args: [], defects: ["wrong-conversation"], expected: expected.lostFollowup },
  { label: "reused-prompt", args: [], defects: ["reused-prompt"], expected: expected.lostFollowup },
  { label: "wrong-request", args: [], defects: ["wrong-request"], expected: expected.lostFollowup },
  { label: "replayed-answer", args: [], defects: ["replayed-answer"], expected: expected.lostFollowup },
  { label: "resume", args: ["--resume"], defects: [], expected: expected.opencodeResume },
  { label: "old-resume", args: ["--resume"], defects: ["old-resume"], expected: expected.claudeOldVersion },
  { label: "resume-bad-epoch", args: ["--resume"], defects: ["resume-bad-epoch"], expected: expected.resumeBadEpoch },
  {
    label: "resume-wrong-source",
    args: ["--resume"],
    defects: ["resume-wrong-source"],
    expected: expected.resumeBadEpoch,
  },
  {
    label: "resume-empty-checkpoint",
    args: ["--resume"],
    defects: ["resume-empty-checkpoint"],
    expected: expected.resumeBadEpoch,
  },
  {
    label: "resume-wrong-watermark",
    args: ["--resume"],
    defects: ["resume-wrong-watermark"],
    expected: expected.resumeBadEpoch,
  },
  {
    label: "resume-wrong-conversation",
    args: ["--resume"],
    defects: ["resume-wrong-conversation"],
    expected: expected.resumeBadEpoch,
  },
  {
    label: "resume-wrong-request",
    args: ["--resume"],
    defects: ["resume-wrong-request"],
    expected: expected.resumeBadEpoch,
  },
  {
    label: "resume-reused-prompt",
    args: ["--resume"],
    defects: ["resume-reused-prompt"],
    expected: expected.resumeBadEpoch,
  },
  {
    label: "resume-not-resumed",
    args: ["--resume"],
    defects: ["resume-not-resumed"],
    expected: expected.resumeBadEpoch,
  },
  { label: "resume-lost", args: ["--resume"], defects: ["resume-lost"], expected: expected.resumeBadEpoch },
  {
    label: "resume-lost-stopped-history",
    args: ["--resume"],
    defects: ["resume-lost-stopped-history"],
    expected: expected.resumeLostStoppedHistory,
  },
  {
    label: "resume-lost-old-history",
    args: ["--resume"],
    defects: ["resume-lost-old-history"],
    expected: expected.resumeBadEpoch,
  },
  {
    label: "resume-tool-result",
    args: ["--resume"],
    defects: ["resume-tool-result"],
    expected: expected.resumeBadEpoch,
  },
  {
    label: "resume-bad-checkpoint",
    args: ["--resume"],
    defects: ["resume-bad-checkpoint"],
    expected: expected.resumeBadCheckpoint,
  },
  {
    label: "resume-stop-unknown",
    args: ["--resume"],
    defects: ["resume-stop-unknown"],
    expected: expected.resumeBadCheckpoint,
  },
  { label: "github", args: ["--github"], defects: [], expected: expected.opencodeGithub },
  { label: "github-resume", args: ["--resume", "--github"], defects: [], expected: expected.opencodeGithubResume },
  {
    label: "github-old-preflight",
    args: ["--github"],
    defects: ["github-old-preflight"],
    expected: expected.githubOldPreflight,
  },
  {
    label: "github-missing-tool",
    args: ["--github"],
    defects: ["github-missing-tool"],
    expected: expected.opencodeGithubDisplayOnly,
  },
  {
    label: "github-no-acquisition",
    args: ["--github"],
    defects: ["github-no-acquisition"],
    expected: expected.opencodeGithubDisplayOnly,
  },
  {
    label: "github-stale-revision",
    args: ["--github"],
    defects: ["github-stale-revision"],
    expected: expected.opencodeGithubDisplayOnly,
  },
  {
    label: "github-wrong-epoch",
    args: ["--github"],
    defects: ["github-wrong-epoch"],
    expected: expected.githubWrongEpoch,
  },
  {
    label: "github-resume-old-config",
    args: ["--resume", "--github"],
    defects: ["github-resume-old-config"],
    expected: expected.githubResumeOldConfig,
  },
  {
    label: "github-resume-reused-revision",
    args: ["--resume", "--github"],
    defects: ["github-resume-reused-revision"],
    expected: expected.githubResumeOldConfig,
  },
  {
    label: "github-echo-mask",
    args: ["--github"],
    defects: ["github-echo-mask"],
    expected: expected.opencodeGithubDisplayOnly,
  },
  {
    label: "github-wrong-output",
    args: ["--github"],
    defects: ["github-wrong-output"],
    expected: expected.opencodeGithubDisplayOnly,
  },
  { label: "github-wrapper", args: ["--github"], defects: ["github-wrapper"], expected: expected.opencodeGithub },
  { label: "mcp", args: ["--mcp"], defects: [], expected: expected.opencodeMcp },
  { label: "mcp-resume", args: ["--resume", "--mcp"], defects: [], expected: expected.opencodeMcpResume },
  {
    label: "mcp-github-resume",
    args: ["--resume", "--github", "--mcp"],
    defects: [],
    expected: expected.mcpGithubResume,
  },
  { label: "mcp-old-version", args: ["--mcp"], defects: ["mcp-old-version"], expected: expected.mcpOldVersion },
  {
    label: "mcp-preflight-denied",
    args: ["--mcp"],
    defects: ["mcp-preflight-denied"],
    expected: expected.mcpOldVersion,
  },
  { label: "mcp-invalid-json", args: ["--mcp"], defects: [], expected: expected.mcpOldVersion, invalidMcpArgs: true },
  { label: "mcp-wrong-server", args: ["--mcp"], defects: ["mcp-wrong-server"], expected: expected.opencodeMcpNoResult },
  { label: "mcp-wrong-tool", args: ["--mcp"], defects: ["mcp-wrong-tool"], expected: expected.opencodeMcpNoResult },
  { label: "mcp-wrong-args", args: ["--mcp"], defects: ["mcp-wrong-args"], expected: expected.opencodeMcpNoResult },
  { label: "mcp-no-result", args: ["--mcp"], defects: ["mcp-no-result"], expected: expected.opencodeMcpNoResult },
  { label: "mcp-error-result", args: ["--mcp"], defects: ["mcp-error-result"], expected: expected.opencodeMcpNoResult },
  { label: "mcp-wrong-output", args: ["--mcp"], defects: ["mcp-wrong-output"], expected: expected.opencodeMcpNoResult },
  { label: "mcp-old-prompt", args: ["--mcp"], defects: ["mcp-old-prompt"], expected: expected.opencodeMcpNoResult },
  {
    label: "mcp-resume-replay",
    args: ["--resume", "--mcp"],
    defects: ["mcp-resume-replay"],
    expected: expected.opencodeMcpResumeReplay,
  },
  { label: "skills", args: ["--skills"], defects: [], expected: expected.skills },
  { label: "skills-empty", args: ["--skills"], defects: ["skills-empty"], expected: expected.skillsEmpty },
  {
    label: "skills-old-version",
    args: ["--skills"],
    defects: ["skills-old-version"],
    expected: expected.skillsOldVersion,
  },
  {
    label: "skills-missing-launch",
    args: ["--skills"],
    defects: ["skills-missing-launch"],
    expected: expected.skillsMissingLaunch,
  },
  {
    label: "skills-wrong-golden",
    args: ["--skills"],
    defects: ["skills-wrong-golden"],
    expected: expected.skillsWrongGolden,
  },
  {
    label: "skills-status-mismatch",
    args: ["--skills"],
    defects: ["skills-status-mismatch"],
    expected: expected.skillsMissingLaunch,
  },
  { label: "skills-resume", args: ["--resume", "--skills"], defects: [], expected: expected.opencodeSkillsResume },
  {
    label: "skills-resume-status-mismatch",
    args: ["--resume", "--skills"],
    defects: ["skills-resume-status-mismatch"],
    expected: expected.skillsResumeStatusMismatch,
  },
  {
    label: "skills-resume-stop-status-mismatch",
    args: ["--resume", "--skills"],
    defects: ["skills-resume-stop-status-mismatch"],
    expected: expected.skillsResumeStopStatusMismatch,
  },
  {
    label: "skills-mcp-github-resume",
    args: ["--resume", "--github", "--mcp", "--skills"],
    defects: [],
    expected: expected.skillsMcpGithubResume,
  },
  { label: "variables", args: ["--variables"], defects: [], expected: expected.opencodeVariables },
  {
    label: "variables-resume",
    args: ["--resume", "--variables"],
    defects: [],
    expected: expected.opencodeVariablesResume,
  },
  {
    label: "variables-skills-mcp-github-resume",
    args: ["--resume", "--github", "--mcp", "--skills", "--variables"],
    defects: [],
    expected: expected.claudeVariablesSkillsMcpGithubResume,
  },
  {
    label: "variables-wrapper",
    args: ["--variables"],
    defects: ["variables-wrapper"],
    expected: expected.opencodeVariables,
  },
  {
    label: "variables-old-version",
    args: ["--variables"],
    defects: ["variables-old-version"],
    expected: expected.variablesOldVersion,
  },
  {
    label: "variables-wrong-template",
    args: ["--variables"],
    defects: ["variables-wrong-template"],
    expected: expected.variablesOldVersion,
  },
  {
    label: "variables-wrong-golden",
    args: ["--variables"],
    defects: ["variables-wrong-golden"],
    expected: expected.variablesOldVersion,
  },
  {
    label: "variables-wrong-account",
    args: ["--variables"],
    defects: ["variables-wrong-account"],
    expected: expected.variablesOldVersion,
  },
  {
    label: "variables-wrong-keys",
    args: ["--variables"],
    defects: ["variables-wrong-keys"],
    expected: expected.variablesOldVersion,
  },
  {
    label: "variables-missing-vars",
    args: ["--variables"],
    defects: ["variables-missing-vars"],
    expected: expected.variablesOldVersion,
  },
  {
    label: "variables-secrets",
    args: ["--variables"],
    defects: ["variables-secrets"],
    expected: expected.variablesOldVersion,
  },
  {
    label: "variables-no-tool",
    args: ["--variables"],
    defects: ["variables-no-tool"],
    expected: expected.opencodeVariablesOldPrompt,
  },
  {
    label: "variables-missing-env",
    args: ["--variables"],
    defects: ["variables-missing-env"],
    expected: expected.opencodeVariablesOldPrompt,
  },
  {
    label: "variables-wrong-hash",
    args: ["--variables"],
    defects: ["variables-wrong-hash"],
    expected: expected.opencodeVariablesOldPrompt,
  },
  {
    label: "variables-echo-mask",
    args: ["--variables"],
    defects: ["variables-echo-mask"],
    expected: expected.opencodeVariablesOldPrompt,
  },
  {
    label: "variables-old-prompt",
    args: ["--variables"],
    defects: ["variables-old-prompt"],
    expected: expected.opencodeVariablesOldPrompt,
  },
  {
    label: "variables-receipt-mismatch",
    args: ["--variables"],
    defects: ["variables-receipt-mismatch"],
    expected: expected.opencodeVariablesOldPrompt,
  },
  {
    label: "variables-resume-replay",
    args: ["--resume", "--variables"],
    defects: ["variables-resume-replay"],
    expected: expected.variablesResumeReplay,
  },
  { label: "usage", args: ["--usage"], defects: [], expected: expected.opencodeUsage },
  { label: "usage-unknown", args: ["--usage"], defects: ["usage-unknown"], expected: expected.usageUnknown },
  { label: "usage-late", args: ["--usage"], defects: ["usage-late"], expected: expected.opencodeUsage },
  {
    label: "usage-extra-observation",
    args: ["--usage"],
    defects: ["usage-extra-observation"],
    expected: expected.opencodeUsage,
  },
  {
    label: "usage-forged-guest-money",
    args: ["--usage"],
    defects: ["usage-forged-guest-money"],
    expected: expected.opencodeUsage,
  },
  { label: "usage-old-version", args: ["--usage"], defects: ["usage-old-version"], expected: expected.usageOldVersion },
  {
    label: "usage-missing-facts",
    args: ["--usage"],
    defects: ["usage-missing-facts"],
    expected: expected.usageMissingFacts,
  },
  {
    label: "usage-wrong-totals",
    args: ["--usage"],
    defects: ["usage-wrong-totals"],
    expected: expected.usageWrongTotals,
  },
  {
    label: "usage-wrong-model",
    args: ["--usage"],
    defects: ["usage-wrong-model"],
    expected: expected.usageWrongTotals,
  },
  {
    label: "usage-wrong-account",
    args: ["--usage"],
    defects: ["usage-wrong-account"],
    expected: expected.usageWrongTotals,
  },
  {
    label: "usage-no-admission",
    args: ["--usage"],
    defects: ["usage-no-admission"],
    expected: expected.usageWrongTotals,
  },
  {
    label: "usage-forged-cost",
    args: ["--usage"],
    defects: ["usage-forged-cost"],
    expected: expected.usageWrongTotals,
  },
  {
    label: "usage-zero-missing",
    args: ["--usage"],
    defects: ["usage-zero-missing"],
    expected: expected.usageWrongTotals,
  },
  {
    label: "usage-stopped-drift",
    args: ["--usage"],
    defects: ["usage-stopped-drift"],
    expected: expected.usageStoppedDrift,
  },
  {
    label: "usage-resume-repricing",
    args: ["--resume", "--usage"],
    defects: ["usage-resume-repricing"],
    expected: expected.usageResumeRepricing,
  },
  {
    label: "usage-resume-stopped-drift",
    args: ["--resume", "--usage"],
    defects: ["usage-resume-stopped-drift"],
    expected: expected.usageResumeStoppedDrift,
  },
  {
    label: "usage-variables-skills-mcp-github-resume",
    args: ["--resume", "--github", "--mcp", "--skills", "--variables", "--usage"],
    defects: [],
    expected: expected.opencodeUsageVariablesSkillsMcpGithubResume,
  },
];
