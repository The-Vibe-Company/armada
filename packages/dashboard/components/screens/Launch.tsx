"use client";

// A ticket's launch (THE-870), as its project's page and ⌘K (THE-895) both
// offer it: one request to the coordinator's inbox (`launchTicket`), shown
// sent at once, put back with the reason when it is refused. Under the
// shared-password gate, the first launch asks for the viewer's name.
import type { ReadyTicket } from "@armada/core/read";
import { useRef, useState } from "react";
import { launchTicket } from "@/app/actions";
import { launchProfileLabel } from "@/lib/project-view";
import { useRequest, useSent } from "../Actions";
import { useFleet, useNow, useShell } from "../shell/context";

/** The state of one ticket's launch: its request, and what was sent before the server shows it. */
export function useLaunch(r: ReadyTicket) {
  const { author, setAuthor, account } = useShell();
  const { overview, failed, version, refresh } = useFleet();
  type Launch = { author: string; at: string };
  const [sent, markSent, unmark] = useSent<Launch>(version);
  const [naming, setNaming] = useState(false);
  const shown = useRef<Launch | null>(null);
  const req = useRequest(launchTicket, {
    start: (form) => {
      const typed = String(form.get("author") ?? "");
      if (!account && typed) setAuthor(typed);
      shown.current = { author: account ? author : typed, at: new Date().toISOString() };
      markSent(shown.current);
      setNaming(false);
    },
    done: () => {
      if (shown.current) markSent(shown.current);
      refresh();
    },
    undo: () => unmark(),
  });
  return {
    req,
    pending: r.launch ?? sent,
    live: overview.live.state === "ok" && !failed,
    needsName: !account && !author,
    naming,
    setNaming,
  };
}

/** The launch button, its name field when one is needed, or the launch already sent. */
export function LaunchControl({ ticket: r, launch }: { ticket: ReadyTicket; launch: ReturnType<typeof useLaunch> }) {
  const { t, author, account } = useShell();
  const now = useNow();
  const { req, pending, live, needsName, naming, setNaming } = launch;
  const profile = r.route?.profile ?? null;
  if (pending)
    return (
      <span
        className="pj-sent"
        role="status"
        title={`${pending.author ? `${pending.author} · ` : ""}${t.ago(Math.max(0, now - Date.parse(pending.at)))}`}
      >
        {t.projectPage.launchSent}
      </span>
    );
  if (!r.readyForAgent) return <span className="pj-wait">{t.projectPage.notReady}</span>;
  if (!live) return null;
  return (
    <form className="pj-launch" onSubmit={req.submit}>
      <input type="hidden" name="project" value={r.project} />
      <input type="hidden" name="ticket" value={r.id} />
      {profile && <input type="hidden" name="profile" value={profile} />}
      {needsName && naming ? (
        <input
          className="pj-name-input"
          name="author"
          placeholder={t.yourName}
          title={t.nameHint}
          aria-label={t.yourName}
          required
          maxLength={80}
          autoComplete="name"
          // biome-ignore lint/a11y/noAutofocus: the field appears on the click that asked for it.
          autoFocus
        />
      ) : (
        !account && author && <input type="hidden" name="author" value={author} />
      )}
      <button
        type={needsName && !naming ? "button" : "submit"}
        className="btn is-soft pj-launch-button"
        disabled={req.busy}
        aria-label={t.launchLabel(r.id)}
        title={t.projectPage.profile(launchProfileLabel(r, t.projectPage.coordinatorChoice))}
        onClick={needsName && !naming ? () => setNaming(true) : undefined}
      >
        {req.busy ? t.sending : t.launch}
      </button>
    </form>
  );
}
