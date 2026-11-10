"use client";

import { CircleAlertIcon, Loader2Icon, UserMinusIcon } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { changeMemberRole, removeMember } from "@/app/actions/orgs";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { type MemberRole, roleChange } from "@/lib/members";

type Member = { org: string; orgName: string; user: string; email: string; role: MemberRole; self: boolean };

function Refusal({ error }: { error: string }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-sm whitespace-normal text-destructive">
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{error}</span>
    </p>
  );
}

/**
 * A member's role, for an admin. Save is offered only once the role differs; giving up your own admin role asks
 * first, in the destructive confirmation every irreversible change uses (#758). A refusal stays in the row.
 */
export function MemberRoleForm({ org, orgName, user, email, role, self }: Member) {
  const [state, action, pending] = useActionState(changeMemberRole, null);
  const [next, setNext] = useState<MemberRole>(role);
  const [confirming, setConfirming] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const change = roleChange(role, next, self);
  // The saved role is the server's: once it changes (a save, another admin), the choice starts from it again.
  useEffect(() => setNext(role), [role]);
  useEffect(() => {
    const node = form.current;
    if (!node) return;
    // React resets a form after its action. The select is controlled and has no default option, so the reset would
    // show "admin" whatever the choice is; the choice and a refusal stay as they were instead.
    const keep = (event: Event) => event.preventDefault();
    node.addEventListener("reset", keep);
    return () => node.removeEventListener("reset", keep);
  }, []);
  return (
    <form
      ref={form}
      action={action}
      className="space-y-1.5"
      onSubmit={(event) => {
        if (change !== "self-demote" || confirming) return;
        event.preventDefault();
        setConfirming(true);
      }}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="user" value={user} />
      <div className="flex items-center gap-2">
        <div className="w-28 shrink-0">
          <NativeSelect
            ref={select}
            name="role"
            value={next}
            onChange={(event) => setNext(event.target.value as MemberRole)}
            aria-label={`Role of ${email}`}
            className="h-8"
          >
            <option value="admin">admin</option>
            <option value="member">member</option>
          </NativeSelect>
        </div>
        {change !== "none" && (
          <Button type="submit" variant="outline" size="sm" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            Save
          </Button>
        )}
      </div>
      {state && !state.ok && <Refusal error={state.error} />}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        {/* Opened by Save, not by a trigger: closing returns focus to the role it is about. */}
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            select.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Give up admin of {orgName}?</AlertDialogTitle>
            <AlertDialogDescription>
              You become a member. Only another admin can make you an admin again, and you can no longer manage its
              members, goldens or providers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                form.current?.requestSubmit();
                setConfirming(false);
              }}
            >
              Make me a member
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}

/**
 * Removes a member after a destructive confirmation that says what they lose. The dialog stays open
 * on a refusal, so the reason is read where the action was taken; on success the row, and the dialog, are gone.
 */
export function RemoveMember({ org, orgName, user, email, self }: Omit<Member, "role">) {
  const [state, action, pending] = useActionState(removeMember, null);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive-outline" size="sm" aria-label={`Remove ${email}`} className="max-sm:px-2.5">
          <UserMinusIcon />
          <span className="max-sm:sr-only">Remove</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{self ? `Leave ${orgName}?` : `Remove ${email} from ${orgName}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {self ? "You lose" : "They lose"} access to its goldens, sandboxes and credentials at once. Only an admin
            can invite {self ? "you" : "them"} back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {state && !state.ok && <Refusal error={state.error} />}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <form action={action}>
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="user" value={user} />
            <Button type="submit" variant="destructive" disabled={pending} className="w-full">
              {pending && <Loader2Icon className="animate-spin" />}
              {self ? "Leave organization" : "Remove member"}
            </Button>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
