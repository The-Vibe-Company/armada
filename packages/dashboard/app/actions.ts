"use server";

// The Fleet view's two actions, as server actions. Each checks the session
// first (proxy.ts already refuses an action without one), then only writes a
// request into the coordinator's inbox; the coordinator carries it out. No
// runtime key is read here or anywhere in the dashboard.
import { cookies } from "next/headers";
import { requireSession } from "@/lib/auth-server";
import { AUTHOR_COOKIE } from "@/lib/i18n";
import { type RequestResult, submitAnswer, submitLaunch } from "@/lib/requests";
import { authorOf, loadOptions } from "@/lib/server";

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/** The name signing the request: the one typed now, remembered for the next request. */
async function author(form: FormData): Promise<string> {
  const jar = await cookies();
  const typed = authorOf(text(form, "author") || undefined);
  if (typed) {
    jar.set(AUTHOR_COOKIE, typed, { path: "/", maxAge: 31_536_000, sameSite: "lax", httpOnly: true, secure: true });
    return typed;
  }
  return authorOf(jar.get(AUTHOR_COOKIE)?.value);
}

export async function answerQuestion(form: FormData): Promise<RequestResult> {
  await requireSession();
  const question = Number(text(form, "question"));
  if (!Number.isSafeInteger(question) || question <= 0)
    return { ok: false, code: "no-question", message: "no question id" };
  return submitAnswer(loadOptions(), {
    project: text(form, "project"),
    question,
    text: text(form, "text"),
    author: await author(form),
  });
}

export async function launchTicket(form: FormData): Promise<RequestResult> {
  await requireSession();
  return submitLaunch(loadOptions(), {
    project: text(form, "project"),
    ticket: text(form, "ticket"),
    profile: text(form, "profile") || null,
    author: await author(form),
  });
}
