import { CircleAlertIcon, MailIcon, ShipIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { ActionResult } from "@/lib/action";
import {
  deliveryLabel,
  expiryLabel,
  INVITATION_ACCEPT_PATH,
  INVITE_ROLES,
  type InvitationView,
  type RecipientState,
  type Tone,
} from "@/lib/invitations";
import { cn } from "@/lib/utils";

type Action = (previous: ActionResult | null, data: FormData) => Promise<ActionResult>;

const TONE: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  success: "border-success/40 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/10 text-warning",
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function InviteForm({ org, action }: { org: string; action: Action }) {
  return (
    <ActionForm action={action} resetOnSuccess className="flex flex-col gap-3">
      <input type="hidden" name="org" value={org} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            autoComplete="off"
            required
            placeholder="teammate@company.com"
          />
        </div>
        <div className="space-y-2 sm:w-32">
          <Label htmlFor="invite-role">Role</Label>
          <NativeSelect id="invite-role" name="role" defaultValue="member" className="w-full">
            {INVITE_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </NativeSelect>
        </div>
        <SubmitButton>
          <MailIcon />
          Send invitation
        </SubmitButton>
      </div>
    </ActionForm>
  );
}

type ListProps = { org: string; invitations: InvitationView[]; now: Date; resend: Action; revoke: Action };

/** Pending invitations: an accepted one is a row in Members, a revoked or expired one is gone. */
export function InvitationList({ org, invitations, now, resend, revoke }: ListProps) {
  if (invitations.length === 0) return <p className="text-sm text-muted-foreground">No pending invitations.</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {invitations.map((invitation) => {
        const delivery = deliveryLabel(invitation.delivery);
        const trouble = invitation.delivery === "failed" || invitation.delivery === "not_configured";
        return (
          <li
            key={invitation.id}
            data-invitation={invitation.email}
            className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-4"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-medium">{invitation.email}</p>
                <Badge
                  variant="outline"
                  className={TONE[delivery.tone]}
                  data-delivery={invitation.delivery}
                  title={delivery.hint}
                >
                  {delivery.label}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {invitation.role} · {expiryLabel(invitation.expiresAt, now)}
              </p>
              {trouble && <p className="mt-1 text-xs text-destructive">{delivery.hint}</p>}
            </div>
            <div className="flex items-start gap-1 sm:justify-end">
              <ActionForm action={resend} className="flex max-w-xs flex-col items-end gap-1 text-right">
                <input type="hidden" name="org" value={org} />
                <input type="hidden" name="invitation" value={invitation.id} />
                <SubmitButton variant="outline" size="sm" aria-label={`Resend the invitation to ${invitation.email}`}>
                  Resend
                </SubmitButton>
              </ActionForm>
              <ActionForm action={revoke} className="flex max-w-xs flex-col items-end gap-1 text-right">
                <input type="hidden" name="org" value={org} />
                <input type="hidden" name="invitation" value={invitation.id} />
                <SubmitButton variant="ghost" size="sm" aria-label={`Revoke the invitation to ${invitation.email}`}>
                  Revoke
                </SubmitButton>
              </ActionForm>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export const INVITATION_LOGIN_HREF = `/login?next=${encodeURIComponent(INVITATION_ACCEPT_PATH)}`;
const article = (role: string) => (role === "admin" ? "an admin" : "a member");

/** Signs out and returns to this invitation's sign-in, keeping the link: "use another account". */
function SwitchAccount({ label, primary = false }: { label: string; primary?: boolean }) {
  return (
    <form action="/auth/signout" method="post">
      <input type="hidden" name="next" value={INVITATION_ACCEPT_PATH} />
      <Button type="submit" variant={primary ? "default" : "outline"} className="w-full sm:w-auto">
        {label}
      </Button>
    </form>
  );
}

const SignedInAs = ({ email }: { email: string }) => (
  <p className="text-xs">
    Signed in as <span className="break-words text-foreground">{email}</span>
  </p>
);

/** The recipient's page. It only explains; joining is the explicit button of the `ready` preview. */
type AcceptProps = {
  state: RecipientState;
  accept: Action;
  /** The `token_hash` link's two explicit steps, and "not now". */
  link: { verify: Action; adopt: Action; discard: Action };
  now: Date;
};

export function AcceptInvitation({ state, accept, link, now }: AcceptProps) {
  switch (state.kind) {
    case "missing":
      return (
        <InvitationShell title="Open your invitation link" alert>
          <p>
            This browser has no invitation to accept. Open the link from the invitation email again, here. If it keeps
            failing, ask the admin who invited you to resend it.
          </p>
        </InvitationShell>
      );
    case "sign_in":
      return (
        <InvitationShell title="You are invited to an organization on Armada">
          <p>
            Armada sent a secure sign-in link with this invitation. Sign in with the address it was sent to, review the
            organization, then choose whether to join. Nothing is joined before you do.
          </p>
          <Button asChild className="w-full sm:w-auto">
            <Link href={INVITATION_LOGIN_HREF}>Sign in to continue</Link>
          </Button>
        </InvitationShell>
      );
    case "link_sign_in":
      return (
        <InvitationShell title="Sign in to review your invitation">
          <p>
            This link includes a secure sign-in for the address the invitation was sent to. Continue to sign in with it,
            then review the organization. Signing in does not join it.
          </p>
          <ActionForm action={link.verify} className="flex flex-col gap-2">
            <SubmitButton className="w-full sm:w-auto">Check this link</SubmitButton>
          </ActionForm>
          <p className="text-xs">
            <Link href={INVITATION_LOGIN_HREF} className="underline underline-offset-4">
              Sign in with your email address instead
            </Link>
          </p>
        </InvitationShell>
      );
    case "link_confirm":
      return (
        <InvitationShell title="Confirm your email address">
          <IntendedEmailIntro />
          <ActionForm action={link.adopt} className="flex flex-col gap-3">
            <IntendedEmailField />
            <SubmitButton className="w-full">Sign in with this link</SubmitButton>
          </ActionForm>
          <ActionForm action={link.discard} className="flex flex-col gap-2">
            <SubmitButton variant="outline" className="w-full">
              Not now
            </SubmitButton>
          </ActionForm>
          <OwnSignIn />
        </InvitationShell>
      );
    case "unavailable":
      return (
        <InvitationShell title="This invitation could not be loaded" alert>
          <p role="alert">{state.message}</p>
          {state.signInAgain ? (
            <SwitchAccount label="Sign in again" primary />
          ) : (
            <Button asChild variant="outline" className="w-full sm:w-auto">
              <Link href={INVITATION_ACCEPT_PATH}>Try again</Link>
            </Button>
          )}
        </InvitationShell>
      );
  }
  const { preview, signedInAs } = state;
  switch (preview.state) {
    case "ready": {
      const { orgName, role, expiresAt } = preview.context;
      return (
        <InvitationShell title={`Join ${orgName}`}>
          <p>
            You are invited as <strong className="text-foreground">{article(role)}</strong>.{" "}
            {/* The server just said it is live: a clock ahead of the server's never reads "Expired" here. */}
            {expiryLabel(expiresAt, now).replace(/^Expired$/, "Expires today")}.
          </p>
          <ActionForm action={accept} className="flex flex-col gap-2">
            <SubmitButton className="w-full sm:w-auto">Accept and join {orgName}</SubmitButton>
          </ActionForm>
          <div className="space-y-2 border-t pt-3">
            <SignedInAs email={signedInAs} />
            <SwitchAccount label="Use another account" />
          </div>
        </InvitationShell>
      );
    }
    case "already_member":
      return (
        <InvitationShell title={`You are already in ${preview.context.orgName}`}>
          <p>Nothing to accept: your account is a member of this organization.</p>
          <Button asChild className="w-full sm:w-auto">
            <Link href="/orgs">Open my organizations</Link>
          </Button>
        </InvitationShell>
      );
    case "used":
      return (
        <InvitationShell title="This invitation was already accepted" alert>
          <p>Each invitation link works once. If it was you, {preview.context.orgName} is in your organizations.</p>
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/orgs">Open my organizations</Link>
          </Button>
        </InvitationShell>
      );
    case "expired":
      return (
        <InvitationShell title={`Your invitation to ${preview.context.orgName} has expired`} alert>
          <p>Ask an admin of {preview.context.orgName} to resend it. The new email has a fresh link.</p>
        </InvitationShell>
      );
    case "revoked":
      return (
        <InvitationShell title={`Your invitation to ${preview.context.orgName} was revoked`} alert>
          <p>An admin cancelled it. Ask them for a new invitation if you still need access.</p>
        </InvitationShell>
      );
    case "not_found":
      return (
        <InvitationShell title="This invitation link is not valid" alert>
          <p>
            It may have been replaced by a newer email. Open the latest invitation email, or ask an admin to resend it.
          </p>
        </InvitationShell>
      );
    case "wrong_email":
      return (
        <InvitationShell title="Signed in with another account" alert>
          <p>
            This invitation was sent to a different address than{" "}
            <strong className="break-words text-foreground">{signedInAs}</strong>. Sign in with the address that
            received the email.
          </p>
          <SwitchAccount label="Use another account" primary />
        </InvitationShell>
      );
    case "unverified_email":
      return (
        <InvitationShell title="Verify your email first" alert>
          <p>
            Your address is not verified yet. Sign in again with the emailed link or code, then come back to accept.
          </p>
          <SwitchAccount label="Sign in again" primary />
        </InvitationShell>
      );
  }
}

/**
 * The person's own statement of who they are signing in as: typed, never pre-filled or suggested from the link, its
 * session or the org (an attacker controls all three). The server compares it with the link's verified account.
 */
export function IntendedEmailField() {
  return (
    <div className="space-y-2">
      <Label htmlFor="intended-email">Your email address</Label>
      <Input
        id="intended-email"
        name="email"
        type="email"
        autoComplete="off"
        spellCheck={false}
        required
        placeholder="you@company.com"
      />
    </div>
  );
}

export function IntendedEmailIntro() {
  return (
    <p>
      This link from your invitation email can sign you in. Type the email address you use, the one the invitation was
      sent to. If it is not this link&apos;s address, nothing changes. Signing in does not join the organization.
    </p>
  );
}

/** The ordinary sign-in from this browser, back to the invitation afterwards. */
export function OwnSignIn() {
  return (
    <p className="text-xs">
      <Link href={INVITATION_LOGIN_HREF} className="underline underline-offset-4">
        Sign in with your email address instead
      </Link>
    </p>
  );
}

export function InvitationShell({
  title,
  alert = false,
  children,
}: {
  title: string;
  alert?: boolean;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <section className="w-full max-w-md space-y-4 rounded-lg border p-6" aria-labelledby="invitation-title">
        <div className="flex items-center gap-2 font-semibold">
          <ShipIcon className="size-5" aria-hidden />
          Armada
        </div>
        <h1 id="invitation-title" className={cn("flex items-center gap-2 text-lg font-semibold")}>
          {alert && <CircleAlertIcon className="size-5 shrink-0 text-destructive" aria-hidden />}
          {title}
        </h1>
        <div className="space-y-4 text-sm text-muted-foreground">{children}</div>
      </section>
    </main>
  );
}
