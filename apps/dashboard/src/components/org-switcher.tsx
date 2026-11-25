"use client";

import type { MemberRole } from "@armada/core";
import { CheckIcon, ChevronDownIcon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { startTransition, useEffect, useRef } from "react";
import { switchOrganization } from "@/app/actions/selected-org";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMutationState } from "@/components/use-mutation-state";
import type { Membership } from "@/lib/data/viewer";

export function OrgSwitcher({
  memberships,
  selected,
  role,
}: {
  memberships: Membership[];
  selected: string | null;
  role: MemberRole | null;
}) {
  const section = usePathname();
  const [result, switchTo, pending] = useMutationState(switchOrganization);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = trigger.current;
    if (!element?.getClientRects().length) return;
    const restoreFocus = refocusOn === selected;
    refocusOn = null;
    if (restoreFocus) element.focus();
  }, [selected]);
  useEffect(() => {
    if (result && !result.ok) refocusOn = null;
  }, [result]);

  if (!selected) {
    return (
      <div className="rounded-md border border-dashed bg-background p-3 text-sm">
        <p className="font-medium">No organization yet</p>
        <p className="mt-1 text-muted-foreground">Snapshots, sandboxes and keys belong to an organization.</p>
        <Button asChild size="sm" className="mt-3">
          <Link href="/orgs">Create an organization</Link>
        </Button>
      </div>
    );
  }

  const name = memberships.find(({ org }) => org.id === selected)?.org.name ?? "Organization";
  const error = result && !result.ok && !pending ? result.error : null;
  function choose(org: string) {
    if (pending || org === selected) return;
    refocusOn = org;
    const data = new FormData();
    data.set("org", org);
    data.set("section", section);
    startTransition(() => switchTo(data));
  }

  return (
    <div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            id="active-org"
            type="button"
            variant="ghost"
            aria-label={`Active organization: ${name}`}
            aria-busy={pending}
            aria-disabled={pending}
            aria-describedby={error ? "active-org-error" : undefined}
            onPointerDown={(event) => {
              if (pending) event.preventDefault();
            }}
            onKeyDown={(event) => {
              if (pending && ["Enter", " ", "ArrowDown"].includes(event.key)) event.preventDefault();
            }}
            className="h-11 w-full justify-start gap-2 rounded-xl px-1.5 has-[>svg]:px-1.5 aria-busy:cursor-progress data-[state=open]:bg-accent"
          >
            <BrandMark />
            <span className="min-w-0 flex-1 truncate text-left font-semibold">{name}</span>
            {role && (
              <span
                data-org-role={role}
                className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {role === "admin" ? "Admin" : "Member"}
              </span>
            )}
            {pending ? (
              <Loader2Icon aria-hidden className="size-3.5 motion-safe:animate-spin" />
            ) : (
              <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width) min-w-44 rounded-xl animate-none!"
        >
          {memberships.map(({ org }) => (
            <DropdownMenuItem
              key={org.id}
              role="menuitemradio"
              aria-checked={org.id === selected}
              textValue={org.name}
              onSelect={() => choose(org.id)}
            >
              <span className="min-w-0 flex-1 truncate">{org.name}</span>
              {org.id === selected && <CheckIcon aria-hidden />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <p role="status" className="sr-only">
        {pending ? "Switching organization…" : ""}
      </p>
      {error && (
        <p id="active-org-error" role="alert" className="mt-1 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

// A redirect can remount the desktop shell. Give focus back to the visible replacement.
let refocusOn: string | null = null;
