"use server";

// The Fleet view's two actions, as server actions. Each checks access first
// (proxy.ts already refuses an action without it), then only writes a request
// into the coordinator's inbox of a project the viewer may see; the
// coordinator carries it out. With accounts, the request is signed with the
// signed-in person and any name in the form is ignored; under the shared
// password gate, with the name the viewer gives. No runtime key is read here
// or anywhere in the dashboard.
import { cookies } from "next/headers";
import { type Access, requireFleetAccess } from "@/lib/access";
import { AUTHOR_COOKIE } from "@/lib/i18n";
import {
  type RequestResult,
  submitAnswer,
  submitLaunch,
  submitMerge,
  submitPlanChanges,
  submitRelease,
} from "@/lib/requests";
import { authorOf, fleetOf } from "@/lib/server";

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/** The name signing the request. */
async function author(access: Access, form: FormData): Promise<string> {
  if (access.kind === "account") return access.viewer.signature;
  // The shared password: the name typed now, remembered for the next request.
  const jar = await cookies();
  const typed = authorOf(text(form, "author") || undefined);
  if (typed) {
    jar.set(AUTHOR_COOKIE, typed, { path: "/", maxAge: 31_536_000, sameSite: "lax", httpOnly: true, secure: true });
    return typed;
  }
  return authorOf(jar.get(AUTHOR_COOKIE)?.value);
}

export async function answerQuestion(form: FormData): Promise<RequestResult> {
  const access = await requireFleetAccess();
  const question = Number(text(form, "question"));
  if (!Number.isSafeInteger(question) || question <= 0)
    return { ok: false, code: "no-question", message: "no question id" };
  const { opts, scope } = await fleetOf(access);
  return submitAnswer(opts, scope, {
    project: text(form, "project"),
    question,
    text: text(form, "text"),
    author: await author(access, form),
  });
}

export async function launchTicket(form: FormData): Promise<RequestResult> {
  const access = await requireFleetAccess();
  const { opts, scope } = await fleetOf(access);
  return submitLaunch(opts, scope, {
    project: text(form, "project"),
    ticket: text(form, "ticket"),
    profile: text(form, "profile") || null,
    author: await author(access, form),
  });
}

export async function mergePullRequest(form: FormData): Promise<RequestResult> {
  const access = await requireFleetAccess();
  const { opts, scope } = await fleetOf(access);
  return submitMerge(opts, scope, {
    project: text(form, "project"),
    pr: Number(text(form, "pr")),
    author: await author(access, form),
  });
}

export async function releaseTicket(form: FormData): Promise<RequestResult> {
  const access = await requireFleetAccess();
  const { opts, scope } = await fleetOf(access);
  return submitRelease(opts, scope, {
    project: text(form, "project"),
    ticket: text(form, "ticket"),
    author: await author(access, form),
  });
}

export async function changePlan(form: FormData): Promise<RequestResult> {
  const access = await requireFleetAccess();
  const question = Number(text(form, "question"));
  if (!Number.isSafeInteger(question) || question <= 0)
    return { ok: false, code: "no-question", message: "no plan id" };
  const { opts, scope } = await fleetOf(access);
  return submitPlanChanges(opts, scope, {
    project: text(form, "project"),
    question,
    text: text(form, "text"),
    author: await author(access, form),
  });
}
