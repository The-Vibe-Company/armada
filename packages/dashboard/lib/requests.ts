// The dashboard's two actions. Neither reaches a worker or a runtime: each
// writes a request into the coordinator's inbox (Turso) of the ticket's
// project, after core checks it against the project as the owner sees it.
import { type Db, RequestRefusal, redact, requestAnswer, requestLaunch } from "@armada/core/read";
import { type LoadOptions, loadProject, type ProjectState } from "./fleet-data";
import type { RequestError } from "./i18n";

export type RequestResult = { ok: true; id: number } | { ok: false; code: RequestError; message: string };

export interface AnswerForm {
  project: string;
  question: number;
  text: string;
  author: string;
}

export interface LaunchForm {
  project: string;
  ticket: string;
  /** Empty: the ticket's routed profile. */
  profile: string | null;
  author: string;
}

async function withProject(
  opts: LoadOptions,
  slug: string,
  write: (state: ProjectState & { db: Db }) => Promise<number>,
): Promise<RequestResult> {
  try {
    const state = await loadProject(opts, slug);
    if (!state) return { ok: false, code: "unknown-project", message: `no project ${slug} on this dashboard` };
    if (!state.db)
      return { ok: false, code: "live-down", message: "Turso is not reachable: requests cannot be recorded now" };
    return { ok: true, id: await write({ ...state, db: state.db }) };
  } catch (err) {
    if (err instanceof RequestRefusal) return { ok: false, code: err.code, message: err.message };
    // The detail stays in the server log: an error may name the database host.
    console.error(`armada dashboard: request not recorded: ${redact(err)}`);
    return { ok: false, code: "failed", message: "the request could not be recorded" };
  }
}

export function submitAnswer(opts: LoadOptions, form: AnswerForm): Promise<RequestResult> {
  return withProject(opts, form.project, ({ db }) =>
    requestAnswer(db, {
      project: form.project,
      question: form.question,
      text: form.text,
      author: form.author,
      now: opts.now(),
    }),
  );
}

export function submitLaunch(opts: LoadOptions, form: LaunchForm): Promise<RequestResult> {
  return withProject(opts, form.project, ({ db, config, report }) =>
    requestLaunch(db, {
      config,
      report,
      ticket: form.ticket,
      profile: form.profile,
      author: form.author,
      now: opts.now(),
    }),
  );
}
