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

const LOGIN_HREF = `/login?next=${encodeURIComponent(INVITATION_ACCEPT_PATH)}`;
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
    Signed in as <span className="break-all text-foreground">{email}</span>
  </p>
);

/** The recipient's page. It only explains; joining is the explicit button of the `ready` preview. */
export function AcceptInvitation({ state, accept, now }: { state: RecipientState; accept: Action; now: Date }) {
  switch (state.kind) {
    case "missing":
      return (
        <Shell title="Open your invitation link" alert>
          <p>
            This browser has no invitation to accept. Open the link from the invitation email again, here. If it keeps
            failing, ask the admin who invited you to resend it.
          </p>
        </Shell>
      );
    case "sign_in":
      return (
        <Shell title="You are invited to an organization on Armada">
          <p>
            Sign in or create your account with the email address the invitation was sent to. You then see the
            organization and accept it here; nothing is joined before you do.
          </p>
          <Button asChild className="w-full sm:w-auto">
            <Link href={LOGIN_HREF}>Sign in to continue</Link>
          </Button>
        </Shell>
      );
    case "unavailable":
      return (
        <Shell title="This invitation could not be loaded" alert>
          <p role="alert">{state.message}</p>
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href={INVITATION_ACCEPT_PATH}>Try again</Link>
          </Button>
        </Shell>
      );
  }
  const { preview, signedInAs } = state;
  switch (preview.state) {
    case "ready": {
      const { orgName, role, expiresAt } = preview.context;
      return (
        <Shell title={`Join ${orgName}`}>
          <p>
            You are invited as <strong className="text-foreground">{article(role)}</strong>.{" "}
            {expiryLabel(expiresAt, now)}.
          </p>
          <ActionForm action={accept} className="flex flex-col gap-2">
            <SubmitButton className="w-full sm:w-auto">Accept and join {orgName}</SubmitButton>
          </ActionForm>
          <div className="space-y-2 border-t pt-3">
            <SignedInAs email={signedInAs} />
            <SwitchAccount label="Use another account" />
          </div>
        </Shell>
      );
    }
    case "already_member":
      return (
        <Shell title={`You are already in ${preview.context.orgName}`}>
          <p>Nothing to accept: your account is a member of this organization.</p>
          <Button asChild className="w-full sm:w-auto">
            <Link href="/orgs">Open my organizations</Link>
          </Button>
        </Shell>
      );
    case "used":
      return (
        <Shell title="This invitation was already accepted" alert>
          <p>Each invitation link works once. If it was you, {preview.context.orgName} is in your organizations.</p>
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/orgs">Open my organizations</Link>
          </Button>
        </Shell>
      );
    case "expired":
      return (
        <Shell title={`Your invitation to ${preview.context.orgName} has expired`} alert>
          <p>Ask an admin of {preview.context.orgName} to resend it. The new email has a fresh link.</p>
        </Shell>
      );
    case "revoked":
      return (
        <Shell title={`Your invitation to ${preview.context.orgName} was revoked`} alert>
          <p>An admin cancelled it. Ask them for a new invitation if you still need access.</p>
        </Shell>
      );
    case "not_found":
      return (
        <Shell title="This invitation link is not valid" alert>
          <p>
            It may have been replaced by a newer email. Open the latest invitation email, or ask an admin to resend it.
          </p>
        </Shell>
      );
    case "wrong_email":
      return (
        <Shell title="Signed in with another account" alert>
          <p>
            This invitation was sent to a different address than{" "}
            <strong className="break-all text-foreground">{signedInAs}</strong>. Sign in with the address that received
            the email.
          </p>
          <SwitchAccount label="Use another account" primary />
        </Shell>
      );
    case "unverified_email":
      return (
        <Shell title="Verify your email first" alert>
          <p>
            Your address is not verified yet. Sign in again with the emailed link or code, then come back to accept.
          </p>
          <SwitchAccount label="Sign in again" primary />
        </Shell>
      );
  }
}

function Shell({ title, alert = false, children }: { title: string; alert?: boolean; children: ReactNode }) {
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
