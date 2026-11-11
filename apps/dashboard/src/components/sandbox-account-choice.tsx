"use client";

import type { SandboxStatus } from "@armada/core";
import { KeyRoundIcon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { bindSandboxAccount } from "@/app/actions/sandbox-account";
import { StopButton } from "@/components/sandbox-actions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { type AccountOption, bindableStatus } from "@/lib/account-recovery";
import type { ActionResult } from "@/lib/action";
import type { AccountChoices } from "@/lib/data/account-recovery";
import { HARNESS_PATH } from "@/lib/model-accounts";
import { cn } from "@/lib/utils";

type Props = {
  sandboxId: string;
  status: SandboxStatus;
  /** The viewer owns the sandbox: only the owner may choose. */
  owner: boolean;
  /** Absent for a viewer who is not the owner: their accounts are never read. */
  choices?: AccountChoices;
  harnessLabel: string;
};

/**
 * A legacy Modal sandbox has no pinned account: its owner chooses one, deliberately and once, before it resumes.
 * Nothing is preselected, and the choice is confirmed before it is sent; a refusal keeps the selection.
 */
export function SandboxAccountChoice({ sandboxId, status, owner, choices, harnessLabel }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const gate = bindableStatus(status);
  const accounts = choices?.state === "ready" ? choices.accounts : [];
  const account = accounts.find((item) => item.id === selected);

  function bind() {
    if (!account) return;
    const data = new FormData();
    data.set("sandbox", sandboxId);
    data.set("credential", account.id);
    data.set("confirm", "yes");
    startTransition(async () => {
      let outcome: ActionResult;
      try {
        outcome = await bindSandboxAccount(null, data);
      } catch {
        outcome = { ok: false, error: "The account could not be bound. Try again." };
      }
      setConfirming(false);
      setResult(outcome);
      if (outcome.ok) router.refresh();
    });
  }

  return (
    <section
      id="account"
      aria-labelledby="account-title"
      className="shrink-0 space-y-4 rounded-xl border border-warning/40 bg-warning/5 px-4 py-4 sm:px-6"
    >
      <div className="space-y-1">
        <h2 id="account-title" className="flex items-center gap-2 text-base font-semibold">
          <KeyRoundIcon className="size-4 text-warning" aria-hidden="true" />
          Choose this sandbox's account
        </h2>
        <p className="text-sm text-muted-foreground">
          It was launched before accounts were pinned. Its turns will run on the account you choose, which cannot be
          changed later. The workspace and conversations are kept.
        </p>
      </div>

      {!owner ? (
        <p className="text-sm text-muted-foreground">Only its owner can choose the account.</p>
      ) : gate === "failed" ? (
        <p className="text-sm text-muted-foreground">
          It failed, so no account can be bound to it. Launch a new sandbox from its golden instead.
        </p>
      ) : choices?.state === "unavailable" ? (
        <p role="alert" className="text-sm text-destructive">
          The accounts could not be loaded: {choices.message}
        </p>
      ) : accounts.length === 0 ? (
        <p className="text-sm">
          No {harnessLabel} account you can use.{" "}
          <Link href={HARNESS_PATH} className="font-medium underline underline-offset-4">
            Add one in Harness
          </Link>
        </p>
      ) : (
        <>
          <RadioGroup
            aria-label="Account"
            name="account"
            value={selected ?? ""}
            disabled={pending}
            onValueChange={(value) => {
              setSelected(value);
              setResult(null);
            }}
          >
            {accounts.map((item) => (
              <AccountRow key={item.id} account={item} checked={selected === item.id} />
            ))}
          </RadioGroup>
          <div className="flex flex-wrap items-center gap-3">
            {gate === "ready" ? (
              <Button type="button" disabled={!account || pending} onClick={() => setConfirming(true)}>
                {pending && <Loader2Icon className="animate-spin" />}
                Use this account
              </Button>
            ) : gate === "wait" ? (
              <p className="text-sm text-muted-foreground">Stopping. The choice opens once it has stopped.</p>
            ) : (
              <>
                <StopButton sandboxId={sandboxId} />
                <p className="text-sm text-muted-foreground">Stop it first, then choose.</p>
              </>
            )}
            {result && (
              <p
                role={result.ok ? "status" : "alert"}
                className={cn("text-sm", result.ok ? "text-muted-foreground" : "text-destructive")}
              >
                {result.ok ? result.message : result.error}
              </p>
            )}
          </div>
        </>
      )}

      <AlertDialog open={confirming && account !== undefined} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Use {account?.name} for this sandbox?</AlertDialogTitle>
            <AlertDialogDescription>
              Its turns run on this {account?.scope === "org" ? "org" : "personal"} {account?.kindLabel}. This cannot be
              changed later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button type="button" onClick={bind} disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              Bind account
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function AccountRow({ account, checked }: { account: AccountOption; checked: boolean }) {
  const id = useId();
  return (
    <Label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border bg-background px-3 py-2.5 text-sm has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
        checked && "border-foreground/40",
      )}
    >
      <RadioGroupItem id={id} value={account.id} className="mt-1" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium break-words">{account.name}</span>
          {account.isDefault && <Badge variant="secondary">Default</Badge>}
        </span>
        <span className="block text-xs text-muted-foreground">
          {account.kindLabel}, {account.scope === "org" ? "org" : "personal"}
        </span>
      </span>
    </Label>
  );
}
