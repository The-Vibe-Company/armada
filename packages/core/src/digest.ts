// Owner-facing summaries (THE-1107). Pure; callers supply records and time.
import type { SinceSummary } from "./catchup.ts";
import type { LabelPhase } from "./types.ts";

export interface DigestFlight {
  project: string;
  ticket: string;
  title: string;
  phase: LabelPhase;
  phaseSince: string;
}

export interface DigestExtras {
  mainRed?: { project: string; since: string; url: string }[];
  deploys?: { project: string; state: "pending" | "success" | "failure"; url: string }[];
  jobs?: {
    project: string;
    ticket: string;
    title: string;
    eta: string | null;
    progress: number | null;
    url?: string;
  }[];
}

export interface DigestInput {
  since: string;
  until: string;
  now: Date;
  summary: SinceSummary;
  inFlight: DigestFlight[];
  phaseMedians: Partial<Record<LabelPhase, number>>;
  /** Merged cycles with complete phase history; estimates require at least three. */
  mergedSamples?: number;
  titles?: Record<string, string>;
  ownerItems?: { project: string; ticket: string | null; title: string; href: string; kind: "plan" | "coordinator" }[];
  skipped?: string[];
  extras?: DigestExtras;
}

export interface Digest extends Omit<DigestInput, "now" | "phaseMedians" | "mergedSamples" | "inFlight"> {
  quiet: boolean;
  inFlight: (DigestFlight & { remainingMinutes: number | null })[];
}

// The normal forward path; exceptional waiting phases have no completion estimate.
const PATH: LabelPhase[] = ["planning", "awaiting-approval", "implementing", "shipping", "ready-to-merge"];

export function buildDigest(input: DigestInput): Digest {
  const { now, phaseMedians, mergedSamples = 0, inFlight, ...rest } = input;
  return {
    ...rest,
    quiet:
      input.summary.merged.length +
        input.summary.stuck.length +
        input.summary.waiting.length +
        (input.ownerItems?.length ?? 0) ===
        0 &&
      !input.extras?.mainRed?.length &&
      !input.extras?.deploys?.length &&
      !input.extras?.jobs?.length,
    inFlight: inFlight.map((s) => {
      const index = PATH.indexOf(s.phase);
      const current = phaseMedians[s.phase];
      const elapsed = Math.max(0, now.getTime() - Date.parse(s.phaseSince));
      const later = PATH.slice(index + 1).reduce((ms, p) => ms + (phaseMedians[p] ?? 0), 0);
      const remainingMinutes =
        mergedSamples >= 3 && index >= 0 && current !== undefined && Number.isFinite(elapsed)
          ? Math.ceil((Math.max(0, current - elapsed) + later) / 60_000)
          : null;
      return { ...s, remainingMinutes };
    }),
  };
}

export const DIGEST_STRINGS = {
  en: {
    header: "Fleet summary",
    merged: "Merged",
    stuck: "Stuck or blocked",
    waiting: "Waiting for you",
    flight: "In progress",
    quiet: "Nothing new: no merges, no blocks, no decisions waiting.",
    blocked: "blocked",
    silent: "no news",
    recovered: "recovered",
    more: (n: number) => `usually ~${n} min more`,
    skipped: (slot: string) => `the ${slot} digest was skipped`,
    kinds: {
      merge: "merge to approve",
      secret: "secret to set",
      validation: "work to validate",
      question: "question to answer",
      plan: "plan to approve",
      coordinator: "coordinator needs attention",
    },
    phases: {
      planning: "planning",
      "awaiting-approval": "awaiting approval",
      implementing: "implementing",
      shipping: "shipping",
      blocked: "blocked",
      "ready-to-merge": "ready to merge",
      "awaiting-validation": "awaiting validation",
    },
    main: "Main failing",
    deploys: "Deployments",
    jobs: "Long jobs",
    eta: "ETA",
    states: { pending: "pending", success: "successful", failure: "failed" },
  },
  fr: {
    header: "Résumé de la flotte",
    merged: "Fusionnés",
    stuck: "Bloqués ou sans nouvelles",
    waiting: "En attente de votre décision",
    flight: "En cours",
    quiet: "Rien de nouveau : aucune fusion, aucun blocage, aucune décision en attente.",
    blocked: "bloqué",
    silent: "sans nouvelles",
    recovered: "repris",
    more: (n: number) => `habituellement ~${n} min de plus`,
    skipped: (slot: string) => `le résumé de ${slot} a été sauté`,
    kinds: {
      merge: "fusion à approuver",
      secret: "secret à fournir",
      validation: "travail à valider",
      question: "question à traiter",
      plan: "plan à approuver",
      coordinator: "coordinateur à vérifier",
    },
    phases: {
      planning: "préparation",
      "awaiting-approval": "en attente d’approbation",
      implementing: "réalisation",
      shipping: "vérification et livraison",
      blocked: "bloqué",
      "ready-to-merge": "prêt à fusionner",
      "awaiting-validation": "en attente de validation",
    },
    main: "Branche principale en échec",
    deploys: "Déploiements",
    jobs: "Travaux longs",
    eta: "Fin estimée",
    states: { pending: "en attente", success: "réussi", failure: "en échec" },
  },
} as const;

export function renderDigest(d: Digest, opts: { language: "en" | "fr"; format: "slack" | "plain"; appUrl: string }) {
  const t = DIGEST_STRINGS[opts.language];
  const clean = (s: string) => {
    const line = s.replace(/[\r\n]/g, " ");
    return opts.format === "slack" ? line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : line;
  };
  const title = (s: { project: string; ticket: string | null; title?: string }) => {
    const name = s.title ?? d.titles?.[`${s.project}/${s.ticket}`];
    return clean(s.ticket ? `${s.ticket}${name ? ` · ${name}` : ""}` : (name ?? s.project));
  };
  const link = (href: string) => {
    const url = new URL(href, opts.appUrl).href;
    return opts.format === "slack" ? `<${url}|${url}>` : url;
  };
  const skipped = (d.skipped ?? []).map((s) => t.skipped(clean(s)));
  if (d.quiet) return [t.quiet, ...skipped].join(" · ");
  const time = (s: string) => new Date(s).toISOString().slice(0, 16).replace("T", " ");
  const out = [
    `${t.header} · ${time(d.since)}–${time(d.until)} UTC${skipped.length ? ` · ${skipped.join("; ")}` : ""}`,
  ];
  const section = (name: string, lines: string[]) => {
    if (lines.length) out.push(`${name}\n${lines.map((l) => `• ${l}`).join("\n")}`);
  };
  section(t.merged, d.summary.merged.map(title));
  section(
    t.stuck,
    d.summary.stuck.map(
      (s) =>
        `${title(s)} · ${t[s.reason]}${s.minutes === null ? "" : ` · ${s.minutes} min`}${s.reason === "silent" && !s.ongoing ? ` · ${t.recovered}` : ""}`,
    ),
  );
  section(t.waiting, [
    ...d.summary.waiting.map((s) => `${title(s)} · ${t.kinds[s.kind]} · ${link(`/approve/${s.id}`)}`),
    ...(d.ownerItems ?? []).map((s) => `${title(s)} · ${t.kinds[s.kind]} · ${link(s.href)}`),
  ]);
  section(
    t.flight,
    d.inFlight.map(
      (s) =>
        `${title(s)} · ${t.phases[s.phase]}${s.remainingMinutes === null ? "" : ` · ${t.more(s.remainingMinutes)}`}`,
    ),
  );
  section(
    t.main,
    (d.extras?.mainRed ?? []).map((s) => `${clean(s.project)} · ${time(s.since)} UTC · ${link(s.url)}`),
  );
  section(
    t.deploys,
    (d.extras?.deploys ?? []).map((s) => `${clean(s.project)} · ${t.states[s.state]} · ${link(s.url)}`),
  );
  section(
    t.jobs,
    (d.extras?.jobs ?? []).map(
      (s) =>
        `${title(s)}${s.progress === null ? "" : ` · ${s.progress}%`}${s.eta ? ` · ${t.eta} ${time(s.eta)} UTC` : ""}${s.url ? ` · ${link(s.url)}` : ""}`,
    ),
  );
  return out.join("\n\n");
}

export interface DigestRequest {
  since: string | null;
  language?: "en" | "fr";
}
export interface DigestResult {
  digest: Digest;
  text: string;
  sent: boolean;
}
