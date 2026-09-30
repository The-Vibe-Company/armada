// Interface strings in English and French. The language is the dashboard's
// own setting: the viewer's choice (a cookie), else ARMADA_DASHBOARD_LANGUAGE,
// else English. Tracker content (titles, statuses, questions) is shown as is.
import type { AgentPhase, CoordinatorState, LaneFlag, WaitingKind } from "@armada/core/read";

export const LANGUAGES = ["en", "fr"] as const;
export type Language = (typeof LANGUAGES)[number];
export const LANGUAGE_COOKIE = "armada-lang";

export const isLanguage = (v: unknown): v is Language => LANGUAGES.includes(v as Language);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A short duration: "<1 min", "12 min", "3 h 05", "2 d". */
function duration(ms: number, day: string): string {
  const d = Math.max(0, ms);
  if (d < MIN) return "<1 min";
  if (d < HOUR) return `${Math.floor(d / MIN)} min`;
  if (d < DAY) {
    const h = Math.floor(d / HOUR);
    const m = Math.floor((d % HOUR) / MIN);
    return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
  }
  return `${Math.floor(d / DAY)} ${day}`;
}

/** Like `duration`, with seconds under a minute: "4 s". */
const elapsed = (ms: number, day: string) => (ms < MIN ? `${Math.max(0, Math.round(ms / 1000))} s` : duration(ms, day));

const en = {
  htmlTitle: "Armada — fleet",
  brandSub: "fleet",
  kicker: "Every project · live",
  heading: "Fleet",
  atWorkLine: (n: number) => (n === 0 ? "No agent at work" : n === 1 ? "1 agent at work" : `${n} agents at work`),
  waitingLine: (n: number) =>
    n === 0 ? "nothing waits for you" : n === 1 ? "1 thing waits for you" : `${n} things wait for you`,
  stats: { waiting: "Waiting for you", atWork: "At work", silent: "Silent", redCi: "Red CI" },
  projects: "Projects",
  allProjects: "All projects",
  coordinator: {
    active: "coordinator active",
    idle: "coordinator idle",
    unknown: "coordinator unknown",
  } satisfies Record<CoordinatorState, string>,
  coordinatorHint: (state: CoordinatorState, ago: string | null) =>
    state === "unknown"
      ? "No inbox read recorded for this project's coordinator"
      : `The coordinator last read its inbox ${ago} ago`,
  waitingTitle: "Waiting for you",
  waitingEmpty: "Nothing waits for you.",
  atWorkTitle: "At work",
  emptyFleet: "No one in flight.",
  emptyFleetHint: "A ticket claimed with armada claim shows here within seconds.",
  noProjects: "No project registered yet.",
  noProjectsHint: "Run armada init in a repository to register it, then reload.",
  kinds: {
    question: "Question",
    blocked: "Blocked",
    approval: "Plan to approve",
    "hand-back": "Ready to merge",
    silent: "Silent",
  } satisfies Record<WaitingKind, string>,
  phases: {
    planning: "Planning",
    "awaiting-approval": "Awaiting approval",
    implementing: "Implementing",
    shipping: "Shipping",
    blocked: "Blocked",
    "ready-to-merge": "Ready to merge",
    released: "Released",
    merged: "Merged, ticket still open",
  } satisfies Record<AgentPhase, string>,
  ciRunning: "CI running",
  ciRed: "Red CI",
  steps: ["Plan", "Approval", "Build", "PR", "CI", "Merge"],
  flags: {
    silent: "silent",
    "ci-failing": "red CI",
    conflict: "conflict",
    "double-claim": "double claim",
    "started-before-blockers": "started before its blockers",
    "no-assignee": "no assignee",
    "no-phase-label": "no phase label",
  } satisfies Record<LaneFlag, string>,
  ci: { success: "CI green", failure: "CI red", pending: "CI running", none: "no CI" },
  draft: "draft",
  merged: "merged",
  noPr: "no pull request yet",
  inPhase: "in phase",
  lastReport: "last report",
  neverReported: "no report yet",
  runtimeUnknown: "runtime ?",
  sourceLive: "Phase from a report newer than the last Linear read",
  sourceInferred: "Phase inferred from Linear and GitHub (no phase label)",
  sourceStatusLine: "Phase from the latest status comment (no phase label)",
  question: "Question",
  open: "Open",
  duration: (ms: number) => duration(ms, "d"),
  ago: (ms: number) => (ms < MIN ? "just now" : `${duration(ms, "d")} ago`),
  live: { ok: "Live", unreachable: "Linear + GitHub only", off: "Linear + GitHub only" },
  offline: "Offline",
  checked: (ms: number) => `checked ${elapsed(ms, "d")} ago`,
  refreshing: "updating…",
  refresh: "Refresh now",
  unreachableBanner: (error: string | null) =>
    `Live activity is unavailable: Turso could not be read${error ? ` (${error})` : ""}. Showing Linear and GitHub; questions, hand-back notes and coordinator activity are hidden until it comes back.`,
  offBanner:
    "Turso is not configured (ARMADA_TURSO_URL), so this view follows Linear and GitHub only: reports show at the next Linear read, and questions and coordinator activity are hidden.",
  projectError: (name: string) => `${name} could not be read`,
  notes: (n: number) => (n === 1 ? "1 note" : `${n} notes`),
  footerRefresh: "Refreshes every 5 s while this tab is open",
  linearRead: (ago: string) => `Linear read ${ago} ago`,
  githubMissing: "GitHub not read",
  language: "Language",
  filterLabel: "Show one project",
  auth: {
    title: "Sign in",
    kicker: "Private fleet",
    heading: "This fleet is private",
    lead: "Enter the dashboard password to see the tickets, agents and pull requests in flight.",
    password: "Password",
    submit: "Open the fleet",
    wrong: "Wrong password. Try again.",
    limited: "Too many wrong passwords from this address. Wait 15 minutes, then try again.",
    hint: "Asked once per browser for 30 days, or until the password changes.",
    logout: "Log out",
    unconfiguredTitle: "The dashboard is locked",
    unconfigured: (variable: string) =>
      `No password is configured, so this dashboard shows nothing. Set ${variable} in the deployment's environment variables, then redeploy.`,
    offInProduction: (variable: string) =>
      `${variable}=off only works in local development. Set a real password in the deployment's environment variables, then redeploy.`,
  },
};

export type Strings = typeof en;

const fr: Strings = {
  htmlTitle: "Armada — flotte",
  brandSub: "flotte",
  kicker: "Tous les projets · en direct",
  heading: "Flotte",
  atWorkLine: (n) => (n === 0 ? "Aucun agent au travail" : n === 1 ? "1 agent au travail" : `${n} agents au travail`),
  waitingLine: (n) =>
    n === 0
      ? "rien n'attend ta décision"
      : n === 1
        ? "1 point attend ta décision"
        : `${n} points attendent ta décision`,
  stats: { waiting: "À toi de jouer", atWork: "Au travail", silent: "Silencieux", redCi: "CI rouge" },
  projects: "Projets",
  allProjects: "Tous les projets",
  coordinator: {
    active: "coordinateur actif",
    idle: "coordinateur inactif",
    unknown: "coordinateur inconnu",
  },
  coordinatorHint: (state, ago) =>
    state === "unknown"
      ? "Aucune lecture de boîte enregistrée pour le coordinateur de ce projet"
      : `Le coordinateur a lu sa boîte il y a ${ago}`,
  waitingTitle: "À toi de jouer",
  waitingEmpty: "Rien n'attend ta décision.",
  atWorkTitle: "Au travail",
  emptyFleet: "Personne en vol.",
  emptyFleetHint: "Un ticket réclamé avec armada claim apparaît ici en quelques secondes.",
  noProjects: "Aucun projet enregistré.",
  noProjectsHint: "Lance armada init dans un dépôt pour l'enregistrer, puis recharge.",
  kinds: {
    question: "Question",
    blocked: "Bloqué",
    approval: "Plan à approuver",
    "hand-back": "Prêt à fusionner",
    silent: "Silencieux",
  },
  phases: {
    planning: "Planification",
    "awaiting-approval": "Attend approbation",
    implementing: "Implémentation",
    shipping: "Livraison",
    blocked: "Bloqué",
    "ready-to-merge": "Prêt à fusionner",
    released: "Libéré",
    merged: "Fusionné, ticket ouvert",
  },
  ciRunning: "CI en cours",
  ciRed: "CI rouge",
  steps: ["Plan", "Approbation", "Implémentation", "PR", "CI", "Fusion"],
  flags: {
    silent: "silencieux",
    "ci-failing": "CI rouge",
    conflict: "conflit",
    "double-claim": "double claim",
    "started-before-blockers": "démarré avant ses bloquants",
    "no-assignee": "sans assigné",
    "no-phase-label": "sans label de phase",
  },
  ci: { success: "CI verte", failure: "CI rouge", pending: "CI en cours", none: "sans CI" },
  draft: "brouillon",
  merged: "fusionnée",
  noPr: "pas encore de pull request",
  inPhase: "dans la phase",
  lastReport: "dernier rapport",
  neverReported: "aucun rapport",
  runtimeUnknown: "runtime ?",
  sourceLive: "Phase issue d'un rapport plus récent que la dernière lecture Linear",
  sourceInferred: "Phase déduite de Linear et GitHub (pas de label de phase)",
  sourceStatusLine: "Phase issue du dernier commentaire de statut (pas de label de phase)",
  question: "Question",
  open: "Ouvrir",
  duration: (ms) => duration(ms, "j"),
  ago: (ms) => (ms < MIN ? "à l'instant" : `il y a ${duration(ms, "j")}`),
  live: { ok: "En direct", unreachable: "Linear + GitHub seulement", off: "Linear + GitHub seulement" },
  offline: "Hors ligne",
  checked: (ms) => `vérifié il y a ${elapsed(ms, "j")}`,
  refreshing: "mise à jour…",
  refresh: "Rafraîchir maintenant",
  unreachableBanner: (error) =>
    `Activité en direct indisponible : Turso n'a pas pu être lu${error ? ` (${error})` : ""}. Affichage depuis Linear et GitHub ; questions, notes de remise et activité du coordinateur masquées jusqu'à son retour.`,
  offBanner:
    "Turso n'est pas configuré (ARMADA_TURSO_URL) : cette vue suit Linear et GitHub seulement. Les rapports apparaissent à la lecture Linear suivante ; questions et activité du coordinateur sont masquées.",
  projectError: (name) => `${name} n'a pas pu être lu`,
  notes: (n) => (n === 1 ? "1 remarque" : `${n} remarques`),
  footerRefresh: "Se rafraîchit toutes les 5 s tant que l'onglet est ouvert",
  linearRead: (ago) => `Linear lu il y a ${ago}`,
  githubMissing: "GitHub non lu",
  language: "Langue",
  filterLabel: "Afficher un projet",
  auth: {
    title: "Connexion",
    kicker: "Flotte privée",
    heading: "Cette flotte est privée",
    lead: "Saisis le mot de passe du tableau de bord pour voir les tickets, les agents et les pull requests en cours.",
    password: "Mot de passe",
    submit: "Ouvrir la flotte",
    wrong: "Mot de passe incorrect. Réessaie.",
    limited: "Trop de mots de passe incorrects depuis cette adresse. Attends 15 minutes, puis réessaie.",
    hint: "Demandé une fois par navigateur pendant 30 jours, ou jusqu'au changement du mot de passe.",
    logout: "Se déconnecter",
    unconfiguredTitle: "Le tableau de bord est verrouillé",
    unconfigured: (variable) =>
      `Aucun mot de passe n'est configuré : ce tableau de bord n'affiche rien. Définis ${variable} dans les variables d'environnement du déploiement, puis redéploie.`,
    offInProduction: (variable) =>
      `${variable}=off ne marche qu'en développement local. Définis un vrai mot de passe dans les variables d'environnement du déploiement, puis redéploie.`,
  },
};

export const STRINGS: Record<Language, Strings> = { en, fr };
