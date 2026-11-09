import { AlertTriangleIcon, CheckCircle2Icon, MailIcon } from "lucide-react";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { ActionResult } from "@/lib/action";
import { deliveryLabel, expiryLabel, INVITE_ROLES, type InvitationView, type RecipientState } from "@/lib/invitations";
import { cn } from "@/lib/utils";

// Presentation of #641. The actions are injected by the page: they are bound to #640's contract, not defined here.

type Action = (previous: ActionResult | null, data: FormData) => Promise<ActionResult>;

const TONE = {
  neutral: "text-muted-foreground",
  success: "border-success/40 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/10 text-warning",
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
} as const;

export function InviteForm({ org, action }: { org: string; action: Action }) {
  return (
    <ActionForm action={action} resetOnSuccess className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <input type="hidden" name="org" value={org} />
      <div className="flex-1 space-y-2">
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
        <NativeSelect id="invite-role" name="role" defaultValue="member">
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
    </ActionForm>
  );
}

type ListProps = {
  org: string;
  invitations: InvitationView[];
  now: Date;
  resend: Action;
  revoke: Action;
};

/** Pending invitations only: an accepted one is a row in Members, a revoked or expired one disappears. */
export function InvitationList({ org, invitations, now, resend, revoke }: ListProps) {
  if (invitations.length === 0) return <p className="text-sm text-muted-foreground">No pending invitations.</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {invitations.map((invitation) => {
        const delivery = deliveryLabel(invitation.delivery);
        return (
          <li
            key={invitation.id}
            data-invitation={invitation.email}
            className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-4"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{invitation.email}</p>
              <p className="text-xs text-muted-foreground">
                {invitation.role} · {expiryLabel(invitation.expiresAt, now)}
              </p>
              {delivery.hint && invitation.delivery === "failed" && (
                <p className="mt-1 text-xs text-destructive">{delivery.hint}</p>
              )}
            </div>
            <Badge
              variant="outline"
              className={cn("self-start sm:self-center", TONE[delivery.tone])}
              data-delivery={invitation.delivery}
              title={delivery.hint}
            >
              {delivery.label}
            </Badge>
            <div className="flex gap-1 sm:justify-end">
              <ActionForm action={resend} className="flex flex-col items-end gap-1">
                <input type="hidden" name="org" value={org} />
                <input type="hidden" name="invitation" value={invitation.id} />
                <SubmitButton variant="outline" size="sm" aria-label={`Resend the invitation to ${invitation.email}`}>
                  Resend
                </SubmitButton>
              </ActionForm>
              <ActionForm action={revoke} className="flex flex-col items-end gap-1">
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

type AcceptProps = {
  state: RecipientState;
  /** The explicit join. Rendered only in the `ready` state: opening the link never accepts. */
  accept: Action;
  /** Sign in, coming back to this invitation. */
  signInHref: string;
  /** Sign out, coming back to this invitation to sign in with the invited address. */
  switchAccountHref: string;
};

const ARTICLE = (role: string) => (role === "admin" ? "an admin" : "a member");

export function AcceptInvitation({ state, accept, signInHref, switchAccountHref }: AcceptProps) {
  if (state.kind === "not_found")
    return (
      <Shell title="Invitation not found" icon="warning">
        <p>This link is incomplete or no longer valid. Ask the admin who invited you for a new invitation.</p>
      </Shell>
    );
  const { preview } = state;
  const joining = `Join ${preview.orgName} as ${ARTICLE(preview.role)}`;
  switch (state.kind) {
    case "expired":
      return (
        <Shell title="This invitation has expired" icon="warning">
          <p>
            Ask an admin of {preview.orgName} to resend it to {preview.email}.
          </p>
        </Shell>
      );
    case "revoked":
      return (
        <Shell title="This invitation was revoked" icon="warning">
          <p>An admin of {preview.orgName} cancelled it. Ask them for a new one if you still need access.</p>
        </Shell>
      );
    case "accepted":
      return (
        <Shell title="This invitation was already used" icon="done">
          <p>If it was you, {preview.orgName} is already in your organizations.</p>
          <Footer>
            <Button asChild>
              <Link href="/orgs">Open my organizations</Link>
            </Button>
          </Footer>
        </Shell>
      );
    case "sign_in":
      return (
        <Shell title={joining}>
          <p>
            Sign in or create your account with <strong className="text-foreground">{preview.email}</strong> to accept.
          </p>
          <Footer>
            <Button asChild>
              <Link href={signInHref}>Continue with {preview.email}</Link>
            </Button>
          </Footer>
        </Shell>
      );
    case "wrong_account":
      return (
        <Shell title="Signed in with another account" icon="warning">
          <p>
            This invitation is for <strong className="text-foreground">{preview.email}</strong>, but you are signed in
            as <strong className="text-foreground">{state.signedInAs}</strong>.
          </p>
          <Footer>
            <Button asChild>
              <Link href={switchAccountHref}>Sign in as {preview.email}</Link>
            </Button>
          </Footer>
        </Shell>
      );
    case "unverified":
      return (
        <Shell title="Verify your email first" icon="warning">
          <p>
            Your account&apos;s address {preview.email} is not verified yet. Sign in again with the emailed link or
            code, then come back to this invitation.
          </p>
          <Footer>
            <Button asChild variant="outline">
              <Link href={switchAccountHref}>Sign in again</Link>
            </Button>
          </Footer>
        </Shell>
      );
    case "ready":
      return (
        <Shell title={joining}>
          <p>You are signed in as {preview.email}. Accepting adds you to the organization.</p>
          <ActionForm action={accept} className="flex flex-col gap-2 pt-2">
            <SubmitButton className="self-start">Accept and join {preview.orgName}</SubmitButton>
          </ActionForm>
        </Shell>
      );
  }
}

function Shell({ title, icon, children }: { title: string; icon?: "warning" | "done"; children: React.ReactNode }) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          {icon === "warning" && <AlertTriangleIcon className="size-5 text-warning" aria-hidden />}
          {icon === "done" && <CheckCircle2Icon className="size-5 text-success" aria-hidden />}
          {title}
        </CardTitle>
        <CardDescription className="sr-only">Organization invitation</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">{children}</CardContent>
    </Card>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return <CardFooter className="px-0 pt-2">{children}</CardFooter>;
}
