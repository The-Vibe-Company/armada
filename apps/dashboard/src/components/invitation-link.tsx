"use client";

import { Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { adoptEmailLink, type EmailLinkCheck, inspectEmailLink } from "@/app/actions/invitation-signin";
import { INVITATION_LOGIN_HREF, InvitationShell } from "@/components/invitations";
import { Button } from "@/components/ui/button";
import { parseEmailLinkFragment } from "@/lib/invitations";

declare global {
  interface Window {
    __armadaEmailLink?: string | undefined;
  }
}

/**
 * Runs while the HTML is parsed, before hydration or any other script: GoTrue's session fragment leaves the address
 * bar and the history at once, so nothing that later reads `location` (a script, an error report, a bookmark) sees it.
 * The bridge below picks it up from memory.
 */
export const STRIP_EMAIL_LINK_SCRIPT = `(function(){var h=location.hash;if(h&&/(^#|&)(access_token|refresh_token|error|error_code)=/.test(h)){window.__armadaEmailLink=h;history.replaceState(history.state,"",location.pathname+location.search)}})()`;

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "choose"; hash: string; check: Extract<EmailLinkCheck, { ok: true }> }
  | { kind: "signing_in"; hash: string; check: Extract<EmailLinkCheck, { ok: true }> }
  | { kind: "error"; message: string };

/**
 * The invitation email's sign-in, when GoTrue put the session in the URL fragment. The server checks who it is and
 * that the invitation is theirs; the person then chooses to continue as that account. Only then is the session
 * stored, and joining is still the page's own button afterwards. The fragment lives in this component's memory only.
 */
export function EmailLinkBridge({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    const hash = window.__armadaEmailLink ?? window.location.hash;
    window.__armadaEmailLink = undefined;
    if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname);
    if (!hash || !parseEmailLinkFragment(hash)) return;
    setPhase({ kind: "checking" });
    inspectEmailLink(hash).then(
      (check) => setPhase(check.ok ? { kind: "choose", hash, check } : { kind: "error", message: check.error }),
      () => setPhase({ kind: "error", message: "This sign-in link could not be checked. Try again." }),
    );
  }, []);

  if (phase.kind === "idle") return children;
  if (phase.kind === "checking")
    return (
      <InvitationShell title="Checking your sign-in link">
        <p className="flex items-center gap-2">
          <Loader2Icon className="size-4 animate-spin" aria-hidden /> One moment.
        </p>
      </InvitationShell>
    );
  if (phase.kind === "error")
    return (
      <InvitationShell title="This sign-in link did not work" alert>
        <p role="alert">{phase.message}</p>
        <Button asChild className="w-full sm:w-auto">
          <Link href={INVITATION_LOGIN_HREF}>Sign in with your email address</Link>
        </Button>
      </InvitationShell>
    );

  const { check, hash } = phase;
  const continueAs = async () => {
    setPhase({ kind: "signing_in", hash, check });
    const result = await adoptEmailLink(hash).catch(() => null);
    if (!result?.ok) {
      setPhase({ kind: "error", message: result && !result.ok ? result.error : "Signing in failed. Try again." });
      return;
    }
    setPhase({ kind: "idle" });
    router.refresh();
  };
  return (
    <InvitationShell title={`Continue as ${check.email}?`}>
      <p>
        This sign-in link is for <strong className="break-words text-foreground">{check.email}</strong>, invited to{" "}
        <strong className="text-foreground">{check.orgName}</strong>. Signing in lets you review the invitation; it does
        not join the organization.
      </p>
      {check.currentEmail && (
        <p role="note">
          This browser is signed in as <strong className="break-words text-foreground">{check.currentEmail}</strong>.
          Continuing signs it in as {check.email} instead.
        </p>
      )}
      <div className="flex flex-col gap-2">
        <Button onClick={continueAs} disabled={phase.kind === "signing_in"} className="w-full">
          {phase.kind === "signing_in" && <Loader2Icon className="animate-spin" />}
          Continue as {check.email}
        </Button>
        <Button variant="outline" onClick={() => setPhase({ kind: "idle" })} className="w-full">
          {check.currentEmail ? `Stay as ${check.currentEmail}` : "Not now"}
        </Button>
      </div>
    </InvitationShell>
  );
}
