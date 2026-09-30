// Interface strings in English and French. The language is the dashboard's
// own setting: the viewer's choice (a cookie), else ARMADA_DASHBOARD_LANGUAGE,
// else English. Tracker content (titles, statuses, questions) is shown as is.
import type { AgentPhase, CoordinatorState, LaneFlag, RequestRefusalCode, WaitingKind } from "@armada/core/read";

export const LANGUAGES = ["en", "fr"] as const;
export type Language = (typeof LANGUAGES)[number];
export const LANGUAGE_COOKIE = "armada-lang";
/** The name that signs the viewer's requests under the shared-password gate. */
export const AUTHOR_COOKIE = "armada-author";

/** Why a request was not recorded: core's refusals, plus what the dashboard itself can hit. */
export type RequestError = RequestRefusalCode | "unknown-project" | "live-down" | "failed";

/** Why signing in or creating an account did not work (a `?error=` of the sign-in page). */
export const AUTH_ERRORS = [
  "not-invited",
  "invalid",
  "unverified",
  "github-unverified",
  "limited",
  "exists",
  "weak",
  "github",
  "failed",
] as const;
export type AuthError = (typeof AUTH_ERRORS)[number];

/** Why an organization change did not work (a `?error=` of the organization pages). */
export const ORG_ERRORS = ["forbidden", "member", "invalid", "gone", "failed"] as const;
export type OrgError = (typeof ORG_ERRORS)[number];

/** What an organization change did (a `?done=` of the organization page). */
export const ORG_NOTICES = ["invited", "cancelled", "updated", "removed", "revoked"] as const;
export type OrgNotice = (typeof ORG_NOTICES)[number];

/** Why a key could not be saved or deleted (a `?error=` of the Keys page). */
export const KEYS_ERRORS = ["forbidden", "invalid", "vault", "failed"] as const;
export type KeysError = (typeof KEYS_ERRORS)[number];

/** What a change on the Keys page did (a `?done=`). */
export const KEYS_NOTICES = ["saved", "deleted"] as const;
export type KeysNotice = (typeof KEYS_NOTICES)[number];

/** The keys the Keys page names: the vault's, plus a person's own Linear key. */
export type KeyLabel =
  | "linear-api-key"
  | "own-linear-api-key"
  | "turso-url"
  | "turso-platform-token"
  | "turso-organization"
  | "turso-database"
  | "turso-database-token"
  | "github-token";

/** Why a code of `armada login` could not be approved or denied, shown on the /device page. */
export const DEVICE_ERRORS = ["unknown", "used", "forbidden", "failed"] as const;
export type DeviceError = (typeof DEVICE_ERRORS)[number];

type Role = "owner" | "admin" | "member";

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
  // The shared-password gate (THE-834), used while accounts are not configured.
  gate: {
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
      `Neither accounts nor a password are configured, so this dashboard shows nothing. Set ${variable}, or the ARMADA_AUTH_ variables for accounts, in the deployment's environment variables, then redeploy.`,
    offInProduction: (variable: string) =>
      `${variable}=off only works in local development. Set a real password in the deployment's environment variables, then redeploy.`,
  },
  auth: {
    title: "Sign in",
    kicker: "Private fleet",
    heading: "Sign in to Armada",
    lead: "Your organization's tickets, agents and pull requests in flight, for its members only.",
    github: "Continue with GitHub",
    orEmail: "or with your email",
    email: "Email",
    password: "Password",
    passwordHint: "12 characters at least",
    name: "Your name",
    signIn: "Sign in",
    signUp: "Create the account",
    toSignUp: "Invited, and no account yet? Create one",
    toSignIn: "Already have an account? Sign in",
    sent: "If this address is invited, a link to confirm it is on its way. Open it to finish signing in.",
    hint: "Accounts are by invitation: ask an owner of your organization to invite your address.",
    logout: "Sign out",
    errors: {
      "not-invited": "This address has no invitation. Ask an owner of your organization to invite it, then try again.",
      invalid: "Wrong email or password.",
      unverified: "Confirm your address first, with the link sent when the account was created.",
      "github-unverified": "GitHub has not verified this address. Verify it in your GitHub settings, then try again.",
      limited: "Too many attempts. Wait a minute, then try again.",
      exists: "An account already uses this address. Sign in instead.",
      weak: "The password needs 12 characters at least.",
      github: "Signing in with GitHub did not complete. Try again.",
      failed: "Signing in did not work. Try again in a moment.",
    } satisfies Record<AuthError, string>,
    incompleteTitle: "The dashboard is locked",
    incomplete: (variables: string) =>
      `Accounts are only partly configured, so this dashboard shows nothing. Set ${variables} in the deployment's environment variables, then redeploy.`,
    unavailableTitle: "Sign-in is unavailable",
    unavailable: "The accounts database cannot be reached, so nobody can sign in right now. Try again in a moment.",
  },
  org: {
    nav: "Organization",
    back: "Back to the fleet",
    welcomeTitle: "Welcome",
    welcomeHeading: (name: string) => `Welcome, ${name}`,
    createLead:
      "Create your organization, then invite the others. The projects already registered on this Armada join the first organization.",
    orgName: "Organization name",
    create: "Create the organization",
    waitLead:
      "Your account is not in an organization yet. Ask an owner to invite your address, then open the link of the invitation.",
    invitationsForYou: "Invitations for you",
    invitedTo: (org: string, role: string) => `${org}, as ${role}`,
    accept: "Accept",
    decline: "Decline",
    invitationTitle: "Invitation",
    invitationHeading: (org: string) => `Join ${org}`,
    invitationLead: (inviter: string, role: string) =>
      `${inviter} invites you to see and act on this organization's fleet, as ${role}.`,
    invitationGone:
      "This invitation cannot be opened: it was accepted, declined, cancelled or it expired, or it was sent to another address.",
    signedInAs: (email: string) =>
      `You are signed in as ${email}. An invitation opens only for the address it was sent to: if it was another one, sign out and sign in with it.`,
    members: "Members",
    you: "you",
    roles: { owner: "owner", admin: "admin", member: "member" } satisfies Record<Role, string>,
    roleHint: "Owners and admins invite and manage members; members see the fleet, answer and ask for launches.",
    role: "Role",
    changeRole: "Change",
    remove: "Remove",
    invite: "Invite someone",
    inviteEmail: "Their email",
    sendInvite: "Invite",
    invitations: "Pending invitations",
    noInvitations: "No invitation waits.",
    copyLink: "Copy link",
    copied: "Copied",
    cancel: "Cancel",
    expires: (date: string) => `expires ${date}`,
    emailNote:
      "No email provider is configured yet: invitation emails go to the server log. Copy the link and send it yourself.",
    onlyAdmins: "Only owners and admins invite and manage members.",
    yourOrganizations: "Your organizations",
    switchTo: "Open",
    current: "current",
    errors: {
      forbidden: "Your role does not allow this.",
      member: "This person is already a member.",
      invalid: "Check the address and the role.",
      gone: "This invitation or member no longer exists.",
      failed: "That did not work. Try again in a moment.",
    } satisfies Record<OrgError, string>,
    notices: {
      invited: "Invitation created. Send its link to the person.",
      cancelled: "Invitation cancelled.",
      updated: "Role changed.",
      removed: "Member removed.",
      revoked: "Key revoked: whatever used it is signed out.",
    } satisfies Record<OrgNotice, string>,
    apiKeys: "API keys",
    apiKeysHint:
      "A key signs a headless coordinator in for this organization, with ARMADA_API_KEY or armada login --api-key. Revoking it signs that coordinator out.",
    noApiKeys: "No API key.",
    apiKeyName: "Key name, e.g. cloud coordinator",
    createApiKey: "Create a key",
    apiKeyCreated: (name: string) => `Key “${name}” created. Copy it now: it is shown only once.`,
    copyKey: "Copy the key",
    keyCreated: (date: string) => `created ${date}`,
    keyUsed: (date: string) => `last used ${date}`,
    keyUnused: "never used",
    revoke: "Revoke",
    onlyOwners: "Only owners create and revoke API keys.",
    keysLink: "Keys: Linear, Turso and GitHub",
  },
  keys: {
    nav: "Keys",
    lead: "The fleet's keys, kept encrypted in Armada. A signed-in terminal receives what it needs, so no machine needs a key file. Once saved, a value is never shown again.",
    vaultOff: (variable: string) =>
      `This Armada keeps no keys yet. Its owner sets ${variable} (32 random bytes: openssl rand -base64 32) in the deployment's environment, then redeploys.`,
    vaultInvalid: (variable: string) =>
      `${variable} is set, but it is not 32 bytes in base64 or hex, so the vault is off. Its owner fixes it and redeploys.`,
    linear: "Linear",
    turso: "Turso",
    tursoHint:
      "With a Platform API token, each terminal gets a database token made for it that expires after 4 hours. Without one, the database token below is handed out as is.",
    github: "GitHub",
    labels: {
      "linear-api-key": "Organization key",
      "own-linear-api-key": "Your own key",
      "turso-url": "Database URL",
      "turso-platform-token": "Platform API token",
      "turso-organization": "Turso organization",
      "turso-database": "Database name",
      "turso-database-token": "Database token (fallback)",
      "github-token": "GitHub token",
    } satisfies Record<KeyLabel, string>,
    hints: {
      "linear-api-key":
        "Linear > Settings > Security & access > Personal API keys. Workers post their comments with it.",
      "own-linear-api-key":
        "Optional. Your terminals use it instead of the organization's, so the comments they post carry your name. Only you use it.",
      "turso-url":
        "libsql://<database>-<organization>.turso.io. Optional with a Platform API token: Armada asks Turso.",
      "turso-platform-token": "turso auth api-tokens mint armada",
      "turso-organization": "Its slug, from turso org list",
      "turso-database": "From turso db list",
      "turso-database-token":
        "Only without a Platform API token. It does not expire: turso db tokens create <database>",
      "github-token": "For the dashboard's own reads (pull requests, armada.toml). Terminals keep GITHUB_TOKEN or gh.",
    } satisfies Record<KeyLabel, string>,
    notSet: "not set",
    setBy: (who: string, when: string) => `set by ${who}, ${when}`,
    unreadable: "sealed with another master key: enter it again",
    save: "Save",
    replace: "Replace",
    remove: "Delete",
    newValue: "New value",
    onlyAdmins: "Only owners and admins set the organization's keys.",
    audit: "Audit",
    auditHint: "Every change and every key handed out: who, which key, when. Never a value.",
    noEvents: "Nothing yet.",
    actions: { set: "set", delete: "deleted", release: "handed out" } satisfies Record<
      "set" | "delete" | "release",
      string
    >,
    nothing: "no key",
    errors: {
      forbidden: "Your role does not allow this.",
      invalid: "This value does not look right for this key.",
      vault: "The vault is off: nothing was saved.",
      failed: "That did not work. Try again in a moment.",
    } satisfies Record<KeysError, string>,
    notices: {
      saved: "Saved. It takes effect on the next command.",
      deleted: "Deleted. It takes effect on the next command.",
    } satisfies Record<KeysNotice, string>,
  },
  device: {
    title: "Sign in from a terminal",
    enterLead: "Type the code your terminal shows after armada login.",
    code: "Code",
    next: "Continue",
    confirmHeading: "Is this your terminal?",
    confirmLead: (email: string, org: string | null) =>
      `A terminal asks to act as ${email}${org ? ` in ${org}` : ""}. Approve only if you just ran armada login and it shows this code.`,
    approve: "Approve",
    deny: "Deny",
    signedInAs: (email: string) => `Signed in as ${email}. Not you? Sign out, and sign in with your account.`,
    approvedHeading: "Terminal signed in",
    approved: "Your terminal is signed in. You can close this page.",
    deniedHeading: "Sign-in denied",
    denied: "That terminal is not signed in.",
    errors: {
      unknown: "This code is unknown or has expired. Run armada login again for a new one.",
      used: "This code was already approved or denied.",
      forbidden: "Another account opened this code first: only it can approve it.",
      failed: "That did not work. Try again in a moment.",
    } satisfies Record<DeviceError, string>,
  },
  answer: "Answer",
  answerSent: "answer sent",
  answerLabel: (ticket: string) => `Your answer to the question on ${ticket}`,
  answerPlaceholder: "Your decision, and why. The coordinator delivers it to the worker and records it on the ticket.",
  quickAnswer: "Answer with this option",
  send: "Send to the coordinator",
  sending: "Sending…",
  cancel: "Cancel",
  signedAs: "Signed",
  change: "change",
  yourName: "Your name",
  nameHint: "Requests are signed with it on the ticket",
  answerPending: (author: string | null, ago: string) => `Answer from ${author ?? "you"} · sent ${ago} ago`,
  waitingForCoordinator: "waiting for the coordinator to deliver it",
  coordinatorAway: "the coordinator is not reading its inbox right now; it will see this at its next read",
  readyTitle: "Ready to launch",
  readyEmpty: "No ticket is ready to start.",
  readyHint: "A launch is a request: the coordinator starts the worker, and its claim closes the request.",
  launch: "Launch",
  launchLabel: (ticket: string) => `Launch ${ticket}`,
  profile: "Profile",
  routed: "routed",
  routedHint: (why: string) => `Routing picks it: ${why}`,
  noProfiles: "armada.toml declares no profile: the coordinator launches with its default.",
  overrideHint: (routed: string) =>
    `Routing picks ${routed}. The coordinator launches with your choice and records on the ticket that you asked for it.`,
  requestLaunch: "Request launch",
  launchPending: (author: string | null, ago: string) => `Launch asked by ${author ?? "you"} · ${ago} ago`,
  notMarkedReady: "not marked ready",
  criticalPath: "critical path",
  unlocks: (n: number) => `unlocks ${n}`,
  moreUnblocked: (n: number) =>
    n === 1 ? "1 more unblocked, not marked ready" : `${n} more unblocked, not marked ready`,
  fewerUnblocked: "Hide the tickets not marked ready",
  needsLive: "Answers and launches go through Turso, which cannot be read right now.",
  requestErrors: {
    "no-author": "Say who you are: the request is signed with your name.",
    "empty-answer": "The answer is empty.",
    "answer-too-long": "The answer is too long (4,000 characters at most).",
    "no-question": "This question no longer exists.",
    "question-closed": "This question was already answered.",
    "answer-waiting": "An answer to this question already waits for the coordinator.",
    "not-ready": "This ticket can no longer start: it left the frontier.",
    "in-flight": "A worker already holds this ticket.",
    "unknown-profile": "This profile is not in the project's armada.toml.",
    "launch-waiting": "A launch of this ticket already waits for the coordinator.",
    "unknown-project": "This project is no longer on the dashboard.",
    "live-down": "Turso cannot be reached: nothing was recorded. Try again in a moment.",
    failed: "The request could not be recorded. Try again in a moment.",
  } satisfies Record<RequestError, string>,
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
  gate: {
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
      `Ni comptes ni mot de passe ne sont configurés : ce tableau de bord n'affiche rien. Définis ${variable}, ou les variables ARMADA_AUTH_ des comptes, dans les variables d'environnement du déploiement, puis redéploie.`,
    offInProduction: (variable) =>
      `${variable}=off ne marche qu'en développement local. Définis un vrai mot de passe dans les variables d'environnement du déploiement, puis redéploie.`,
  },
  auth: {
    title: "Connexion",
    kicker: "Flotte privée",
    heading: "Se connecter à Armada",
    lead: "Les tickets, agents et pull requests en cours de ton organisation, pour ses membres seulement.",
    github: "Continuer avec GitHub",
    orEmail: "ou avec ton email",
    email: "Email",
    password: "Mot de passe",
    passwordHint: "12 caractères au moins",
    name: "Ton nom",
    signIn: "Se connecter",
    signUp: "Créer le compte",
    toSignUp: "Invité, et pas encore de compte ? Crée-le",
    toSignIn: "Déjà un compte ? Connecte-toi",
    sent: "Si cette adresse est invitée, un lien pour la confirmer arrive. Ouvre-le pour finir la connexion.",
    hint: "Les comptes sont sur invitation : demande à un propriétaire de ton organisation d'inviter ton adresse.",
    logout: "Se déconnecter",
    errors: {
      "not-invited":
        "Cette adresse n'a pas d'invitation. Demande à un propriétaire de ton organisation de l'inviter, puis réessaie.",
      invalid: "Email ou mot de passe incorrect.",
      unverified: "Confirme d'abord ton adresse, avec le lien envoyé à la création du compte.",
      "github-unverified": "GitHub n'a pas vérifié cette adresse. Vérifie-la dans tes réglages GitHub, puis réessaie.",
      limited: "Trop de tentatives. Attends une minute, puis réessaie.",
      exists: "Un compte utilise déjà cette adresse. Connecte-toi plutôt.",
      weak: "Le mot de passe doit compter 12 caractères au moins.",
      github: "La connexion avec GitHub n'a pas abouti. Réessaie.",
      failed: "La connexion n'a pas marché. Réessaie dans un instant.",
    },
    incompleteTitle: "Le tableau de bord est verrouillé",
    incomplete: (variables) =>
      `Les comptes ne sont configurés qu'en partie : ce tableau de bord n'affiche rien. Définis ${variables} dans les variables d'environnement du déploiement, puis redéploie.`,
    unavailableTitle: "Connexion indisponible",
    unavailable:
      "La base des comptes est injoignable : personne ne peut se connecter pour l'instant. Réessaie dans un instant.",
  },
  org: {
    nav: "Organisation",
    back: "Retour à la flotte",
    welcomeTitle: "Bienvenue",
    welcomeHeading: (name) => `Bienvenue, ${name}`,
    createLead:
      "Crée ton organisation, puis invite les autres. Les projets déjà enregistrés sur cet Armada rejoignent la première organisation.",
    orgName: "Nom de l'organisation",
    create: "Créer l'organisation",
    waitLead:
      "Ton compte n'est dans aucune organisation pour l'instant. Demande à un propriétaire d'inviter ton adresse, puis ouvre le lien de l'invitation.",
    invitationsForYou: "Invitations pour toi",
    invitedTo: (org, role) => `${org}, comme ${role}`,
    accept: "Accepter",
    decline: "Refuser",
    invitationTitle: "Invitation",
    invitationHeading: (org) => `Rejoindre ${org}`,
    invitationLead: (inviter, role) =>
      `${inviter} t'invite à voir la flotte de cette organisation et à y agir, comme ${role}.`,
    invitationGone:
      "Cette invitation ne peut pas s'ouvrir : acceptée, refusée, annulée, expirée, ou envoyée à une autre adresse.",
    signedInAs: (email) =>
      `Tu es connecté comme ${email}. Une invitation ne s'ouvre que pour l'adresse à laquelle elle a été envoyée : si c'en était une autre, déconnecte-toi et connecte-toi avec elle.`,
    members: "Membres",
    you: "toi",
    roles: { owner: "propriétaire", admin: "admin", member: "membre" },
    roleHint:
      "Propriétaires et admins invitent et gèrent les membres ; les membres voient la flotte, répondent et demandent des lancements.",
    role: "Rôle",
    changeRole: "Changer",
    remove: "Retirer",
    invite: "Inviter quelqu'un",
    inviteEmail: "Son email",
    sendInvite: "Inviter",
    invitations: "Invitations en attente",
    noInvitations: "Aucune invitation en attente.",
    copyLink: "Copier le lien",
    copied: "Copié",
    cancel: "Annuler",
    expires: (date) => `expire le ${date}`,
    emailNote:
      "Aucun fournisseur d'email n'est configuré : les emails d'invitation vont dans le journal du serveur. Copie le lien et envoie-le toi-même.",
    onlyAdmins: "Seuls les propriétaires et les admins invitent et gèrent les membres.",
    yourOrganizations: "Tes organisations",
    switchTo: "Ouvrir",
    current: "actuelle",
    errors: {
      forbidden: "Ton rôle ne le permet pas.",
      member: "Cette personne est déjà membre.",
      invalid: "Vérifie l'adresse et le rôle.",
      gone: "Cette invitation ou ce membre n'existe plus.",
      failed: "Ça n'a pas marché. Réessaie dans un instant.",
    },
    notices: {
      invited: "Invitation créée. Envoie son lien à la personne.",
      cancelled: "Invitation annulée.",
      updated: "Rôle changé.",
      removed: "Membre retiré.",
      revoked: "Clé révoquée : ce qui l'utilisait est déconnecté.",
    },
    apiKeys: "Clés d'API",
    apiKeysHint:
      "Une clé connecte un coordinateur sans navigateur pour cette organisation, avec ARMADA_API_KEY ou armada login --api-key. La révoquer le déconnecte.",
    noApiKeys: "Aucune clé d'API.",
    apiKeyName: "Nom de la clé, par ex. coordinateur cloud",
    createApiKey: "Créer une clé",
    apiKeyCreated: (name) => `Clé « ${name} » créée. Copie-la maintenant : elle n'est montrée qu'une fois.`,
    copyKey: "Copier la clé",
    keyCreated: (date) => `créée le ${date}`,
    keyUsed: (date) => `utilisée le ${date}`,
    keyUnused: "jamais utilisée",
    revoke: "Révoquer",
    onlyOwners: "Seuls les propriétaires créent et révoquent les clés d'API.",
    keysLink: "Clés : Linear, Turso et GitHub",
  },
  keys: {
    nav: "Clés",
    lead: "Les clés de la flotte, gardées chiffrées dans Armada. Un terminal connecté reçoit ce qu'il lui faut : aucune machine n'a besoin d'un fichier de clés. Une fois enregistrée, une valeur ne s'affiche plus jamais.",
    vaultOff: (variable) =>
      `Cet Armada ne garde pas encore de clés. Son propriétaire définit ${variable} (32 octets aléatoires : openssl rand -base64 32) dans l'environnement du déploiement, puis redéploie.`,
    vaultInvalid: (variable) =>
      `${variable} est défini, mais ne fait pas 32 octets en base64 ou en hexadécimal : le coffre est coupé. Son propriétaire le corrige et redéploie.`,
    linear: "Linear",
    turso: "Turso",
    tursoHint:
      "Avec un jeton de l'API Platform, chaque terminal reçoit un jeton de base fait pour lui, qui expire au bout de 4 heures. Sans lui, le jeton de base ci-dessous est remis tel quel.",
    github: "GitHub",
    labels: {
      "linear-api-key": "Clé de l'organisation",
      "own-linear-api-key": "Ta propre clé",
      "turso-url": "URL de la base",
      "turso-platform-token": "Jeton de l'API Platform",
      "turso-organization": "Organisation Turso",
      "turso-database": "Nom de la base",
      "turso-database-token": "Jeton de base (secours)",
      "github-token": "Jeton GitHub",
    },
    hints: {
      "linear-api-key":
        "Linear > Settings > Security & access > Personal API keys. Les workers publient leurs commentaires avec.",
      "own-linear-api-key":
        "Facultative. Tes terminaux l'utilisent à la place de celle de l'organisation : leurs commentaires portent ton nom. Toi seul t'en sers.",
      "turso-url":
        "libsql://<base>-<organisation>.turso.io. Facultative avec un jeton de l'API Platform : Armada la demande à Turso.",
      "turso-platform-token": "turso auth api-tokens mint armada",
      "turso-organization": "Son identifiant, d'après turso org list",
      "turso-database": "D'après turso db list",
      "turso-database-token": "Seulement sans jeton de l'API Platform. Il n'expire pas : turso db tokens create <base>",
      "github-token":
        "Pour les lectures du tableau de bord (pull requests, armada.toml). Les terminaux gardent GITHUB_TOKEN ou gh.",
    },
    notSet: "non définie",
    setBy: (who, when) => `définie par ${who}, ${when}`,
    unreadable: "scellée avec une autre clé maître : saisis-la à nouveau",
    save: "Enregistrer",
    replace: "Remplacer",
    remove: "Supprimer",
    newValue: "Nouvelle valeur",
    onlyAdmins: "Seuls les propriétaires et les admins définissent les clés de l'organisation.",
    audit: "Journal",
    auditHint: "Chaque changement et chaque clé remise : qui, quelle clé, quand. Jamais une valeur.",
    noEvents: "Rien pour l'instant.",
    actions: { set: "définie", delete: "supprimée", release: "remise" },
    nothing: "aucune clé",
    errors: {
      forbidden: "Ton rôle ne le permet pas.",
      invalid: "Cette valeur ne semble pas convenir à cette clé.",
      vault: "Le coffre est coupé : rien n'a été enregistré.",
      failed: "Ça n'a pas marché. Réessaie dans un instant.",
    },
    notices: {
      saved: "Enregistrée. Elle vaut dès la prochaine commande.",
      deleted: "Supprimée. Cela vaut dès la prochaine commande.",
    },
  },
  device: {
    title: "Connexion depuis un terminal",
    enterLead: "Tape le code que ton terminal affiche après armada login.",
    code: "Code",
    next: "Continuer",
    confirmHeading: "Est-ce ton terminal ?",
    confirmLead: (email, org) =>
      `Un terminal demande à agir comme ${email}${org ? ` dans ${org}` : ""}. N'approuve que si tu viens de lancer armada login et qu'il affiche ce code.`,
    approve: "Approuver",
    deny: "Refuser",
    signedInAs: (email) => `Connecté comme ${email}. Pas toi ? Déconnecte-toi, et connecte-toi avec ton compte.`,
    approvedHeading: "Terminal connecté",
    approved: "Ton terminal est connecté. Tu peux fermer cette page.",
    deniedHeading: "Connexion refusée",
    denied: "Ce terminal n'est pas connecté.",
    errors: {
      unknown: "Ce code est inconnu ou a expiré. Relance armada login pour en avoir un nouveau.",
      used: "Ce code a déjà été approuvé ou refusé.",
      forbidden: "Un autre compte a ouvert ce code en premier : lui seul peut l'approuver.",
      failed: "Ça n'a pas marché. Réessaie dans un instant.",
    },
  },
  answer: "Répondre",
  answerSent: "réponse envoyée",
  answerLabel: (ticket) => `Ta réponse à la question de ${ticket}`,
  answerPlaceholder: "Ta décision, et pourquoi. Le coordinateur la transmet au worker et la note sur le ticket.",
  quickAnswer: "Répondre avec cette option",
  send: "Envoyer au coordinateur",
  sending: "Envoi…",
  cancel: "Annuler",
  signedAs: "Signé",
  change: "changer",
  yourName: "Ton nom",
  nameHint: "Les demandes sont signées de ce nom sur le ticket",
  answerPending: (author, ago) => `Réponse de ${author ?? "toi"} · envoyée il y a ${ago}`,
  waitingForCoordinator: "en attente de transmission par le coordinateur",
  coordinatorAway: "le coordinateur ne lit pas sa boîte en ce moment ; il la verra à sa prochaine lecture",
  readyTitle: "Prêts à lancer",
  readyEmpty: "Aucun ticket n'est prêt à démarrer.",
  readyHint: "Un lancement est une demande : le coordinateur démarre le worker, et son claim clôt la demande.",
  launch: "Lancer",
  launchLabel: (ticket) => `Lancer ${ticket}`,
  profile: "Profil",
  routed: "routé",
  routedHint: (why) => `Choisi par le routage : ${why}`,
  noProfiles: "armada.toml ne déclare aucun profil : le coordinateur lance avec son défaut.",
  overrideHint: (routed) =>
    `Le routage choisit ${routed}. Le coordinateur lance avec ton choix et note sur le ticket que tu l'as demandé.`,
  requestLaunch: "Demander le lancement",
  launchPending: (author, ago) => `Lancement demandé par ${author ?? "toi"} · il y a ${ago}`,
  notMarkedReady: "pas marqué prêt",
  criticalPath: "chemin critique",
  unlocks: (n) => `débloque ${n}`,
  moreUnblocked: (n) => (n === 1 ? "1 autre débloqué, pas marqué prêt" : `${n} autres débloqués, pas marqués prêts`),
  fewerUnblocked: "Masquer les tickets pas marqués prêts",
  needsLive: "Réponses et lancements passent par Turso, illisible pour le moment.",
  requestErrors: {
    "no-author": "Dis qui tu es : la demande est signée de ton nom.",
    "empty-answer": "La réponse est vide.",
    "answer-too-long": "La réponse est trop longue (4 000 caractères au plus).",
    "no-question": "Cette question n'existe plus.",
    "question-closed": "Cette question a déjà reçu une réponse.",
    "answer-waiting": "Une réponse à cette question attend déjà le coordinateur.",
    "not-ready": "Ce ticket ne peut plus démarrer : il a quitté la frontière.",
    "in-flight": "Un worker tient déjà ce ticket.",
    "unknown-profile": "Ce profil n'est pas dans l'armada.toml du projet.",
    "launch-waiting": "Un lancement de ce ticket attend déjà le coordinateur.",
    "unknown-project": "Ce projet n'est plus sur le tableau de bord.",
    "live-down": "Turso est injoignable : rien n'a été enregistré. Réessaie dans un instant.",
    failed: "La demande n'a pas pu être enregistrée. Réessaie dans un instant.",
  },
};

export const STRINGS: Record<Language, Strings> = { en, fr };
