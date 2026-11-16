"use client";

import type { MemberRole } from "@armada/core";
import { Loader2Icon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ChangeEvent, type KeyboardEvent, startTransition, useEffect, useRef, useState } from "react";
import { switchOrganization } from "@/app/actions/selected-org";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useMutationState } from "@/components/use-mutation-state";
import type { Membership } from "@/lib/data/viewer";

/**
 * The organization every page is scoped to, and the viewer's role in it. Choosing another one switches to it at
 * once (the server checks the membership and picks the destination); while that runs the choice is locked, and a
 * refusal puts the selector back on the organization the page is actually showing. Stepping through the closed
 * selector with the keyboard only previews an org: Enter switches to it, Escape or leaving the selector does not.
 */
export function OrgSwitcher({
  memberships,
  selected,
  role,
}: {
  memberships: Membership[];
  selected: string | null;
  role: MemberRole | null;
}) {
  const pathname = usePathname();
  if (!selected) {
    return (
      <div className="mx-3 mb-3 rounded-md border border-dashed bg-background p-3 text-sm md:mb-4">
        <p className="font-medium">No organization yet</p>
        <p className="mt-1 text-muted-foreground">Snapshots, sandboxes and keys belong to an organization.</p>
        <Button asChild size="sm" className="mt-3">
          <Link href="/orgs">Create an organization</Link>
        </Button>
      </div>
    );
  }
  return <SelectedOrg memberships={memberships} selected={selected} role={role} section={pathname} />;
}

// A switch revalidates the layout and redirects, which mounts the shell anew: the selector that had focus is gone,
// so its replacement takes the focus back (a keyboard user keeps their place). Only the mount that shows the org
// switched to takes it, and any mount clears it: a switch that never landed cannot steal focus later.
let refocusOn: string | null = null;

// Keys that step a closed select through its options in place (Windows and Linux), firing a change at each step.
const STEP = new Set(["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

function SelectedOrg({
  memberships,
  selected,
  role,
  section,
}: {
  memberships: Membership[];
  selected: string;
  role: MemberRole | null;
  section: string;
}) {
  const [result, switchTo, pending] = useMutationState(switchOrganization);
  const select = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const focus = refocusOn === selected;
    refocusOn = null;
    if (focus) select.current?.focus();
  }, [selected]);
  // The organization asked for, until its switch settles: shown meanwhile, and no second switch starts.
  const [target, setTarget] = useState<string | null>(null);
  // An org reached by stepping with the keyboard: shown, switched to only on Enter.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Settle on what the server answered (adjusting state during render, not in an effect): a refusal returns a
  // result; a switch redirects and re-renders the shell, so its transition ends with `selected` already updated.
  const [seen, setSeen] = useState({ result, pending, selected });
  if (seen.result !== result || seen.pending !== pending || seen.selected !== selected) {
    setSeen({ result, pending, selected });
    if (seen.result !== result && result && !result.ok) setError(result.error);
    if (seen.selected !== selected) setError(null);
    if ((seen.pending && !pending) || seen.result !== result || seen.selected !== selected) setTarget(null);
  }
  const busy = pending || target !== null;
  // Set while a stepping key is down: its change is the keyboard browsing, not a choice.
  const stepping = useRef(false);

  function commit(org: string, element: HTMLSelectElement) {
    setDraft(null);
    // Left unset, the controlled select snaps back: a change during a switch is ignored, not queued.
    if (busy || org === selected) return;
    setTarget(org);
    setError(null);
    refocusOn = document.activeElement === element ? org : null;
    const data = new FormData();
    data.set("org", org);
    data.set("section", section);
    startTransition(() => switchTo(data));
  }

  function choose(event: ChangeEvent<HTMLSelectElement>) {
    if (stepping.current && !busy) setDraft(event.target.value === selected ? null : event.target.value);
    else commit(event.target.value, event.target);
  }

  function key(event: KeyboardEvent<HTMLSelectElement>) {
    // Typing a letter also jumps to a matching option in place.
    if (STEP.has(event.key) || (event.key.length === 1 && event.key !== " ")) {
      stepping.current = true;
      // The change a key causes fires before this task ends; a later one (from the open list) is a choice.
      setTimeout(() => {
        stepping.current = false;
      });
    } else if (event.key === "Enter" && draft) {
      event.preventDefault();
      commit(draft, event.currentTarget);
    } else if (event.key === "Escape" && draft) setDraft(null);
  }

  const described = [draft && "active-org-hint", error && "active-org-error"].filter(Boolean).join(" ");
  return (
    <div className="relative space-y-1.5 rounded-lg px-1.5 py-1 hover:bg-[var(--raised)]">
      <div className="flex items-center justify-between gap-2 pl-10">
        <Label htmlFor="active-org" className="sr-only">
          Active organization
        </Label>
        {busy ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" aria-hidden>
            <Loader2Icon className="size-3 animate-spin" />
            Switching
          </span>
        ) : (
          role && (
            <span className="text-xs text-muted-foreground" data-org-role={role}>
              {role === "admin" ? "Admin" : "Member"}
            </span>
          )
        )}
      </div>
      <div className="flex items-center gap-2.5">
        <BrandMark />
        <NativeSelect
          ref={select}
          id="active-org"
          name="org"
          value={target ?? draft ?? selected}
          onChange={choose}
          onKeyDown={key}
          onBlur={() => setDraft(null)}
          aria-busy={busy}
          aria-disabled={busy}
          aria-describedby={described || undefined}
          className="h-7 border-0 bg-transparent px-0 text-[13px] font-semibold shadow-none aria-disabled:cursor-progress dark:bg-transparent"
        >
          {memberships.map(({ org }) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      {draft && (
        <p id="active-org-hint" className="px-0 text-xs text-muted-foreground md:px-2">
          Press Enter to switch.
        </p>
      )}
      <p role="status" className="sr-only">
        {busy ? "Switching organization…" : ""}
      </p>
      {error && (
        <p id="active-org-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
