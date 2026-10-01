// The dashboard's two actions. Neither reaches a worker or a runtime: each
// writes a request into the coordinator's inbox (the app's database) of the ticket's
// project, after core checks it against the project as the viewer sees it. A
// project outside the viewer's organization is unknown here.
import { RequestRefusal, requestAnswer, requestLaunch } from "@armada/core/read";
import { redactDatabase } from "./db";
import { type LoadOptions, loadProject, type ProjectState, type Scope } from "./fleet-data";
import type { LiveStore } from "./fleet-store";
import type { RequestError } from "./i18n";

export type RequestResult = { ok: true; id: number } | { ok: false; code: RequestError; message: string };

export interface AnswerForm {
  project: string;
  question: number;
  text: string;
  /** The signed-in person (`signatureOf`); under the shared-password gate, the name the viewer gave. */
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
  scope: Scope | null,
  slug: string,
  write: (state: ProjectState & { store: LiveStore }) => Promise<number>,
): Promise<RequestResult> {
  try {
    const state = await loadProject(opts, slug, scope);
    if (!state) return { ok: false, code: "unknown-project", message: `no project ${slug} on this dashboard` };
    if (!state.store)
      return {
        ok: false,
        code: "live-down",
        message: "the database is not reachable: requests cannot be recorded now",
      };
    return { ok: true, id: await write({ ...state, store: state.store }) };
  } catch (err) {
    if (err instanceof RequestRefusal) return { ok: false, code: err.code, message: err.message };
    // The detail stays in the server log: an error may name the database host.
    console.error(`armada dashboard: request not recorded: ${redactDatabase(err)}`);
    return { ok: false, code: "failed", message: "the request could not be recorded" };
  }
}

export function submitAnswer(opts: LoadOptions, scope: Scope | null, form: AnswerForm): Promise<RequestResult> {
  return withProject(opts, scope, form.project, ({ store }) =>
    requestAnswer(store, {
      project: form.project,
      question: form.question,
      text: form.text,
      author: form.author,
      now: opts.now(),
    }),
  );
}

export function submitLaunch(opts: LoadOptions, scope: Scope | null, form: LaunchForm): Promise<RequestResult> {
  return withProject(opts, scope, form.project, ({ store, config, report }) =>
    requestLaunch(store, {
      config,
      report,
      ticket: form.ticket,
      profile: form.profile,
      author: form.author,
      now: opts.now(),
    }),
  );
}
