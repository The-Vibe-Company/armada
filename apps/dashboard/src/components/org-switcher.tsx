"use client";

import type { MemberRole } from "@armada/core";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useFormStatus } from "react-dom";
import { switchOrganization } from "@/app/actions/selected-org";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { Membership } from "@/lib/data/viewer";

/**
 * The organization every page is scoped to, and the viewer's role in it. Choosing another one shows the switch
 * button; nothing changes until it is submitted (by click or keyboard), so a stray selection is harmless.
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
        <p className="mt-1 text-muted-foreground">Goldens, sandboxes and keys belong to an organization.</p>
        <Button asChild size="sm" className="mt-3">
          <Link href="/orgs">Create an organization</Link>
        </Button>
      </div>
    );
  }
  return <SelectedOrg key={selected} memberships={memberships} selected={selected} role={role} section={pathname} />;
}

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
  const [value, setValue] = useState(selected);
  return (
    <ActionForm action={switchOrganization} className="space-y-1.5 px-4 pb-3 md:px-3 md:pb-4">
      <div className="flex items-center justify-between gap-2 px-0 md:px-2">
        <Label htmlFor="active-org" className="text-xs font-medium text-muted-foreground">
          Active organization
        </Label>
        {role && (
          <span className="text-xs text-muted-foreground" data-org-role={role}>
            {role === "admin" ? "Admin" : "Member"}
          </span>
        )}
      </div>
      <div className="flex gap-2 md:flex-col">
        <NativeSelect
          id="active-org"
          name="org"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="bg-background font-medium"
        >
          {memberships.map(({ org }) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))}
        </NativeSelect>
        <input type="hidden" name="section" value={section.split("/")[1]} />
        {memberships.length > 1 && value !== selected && <SwitchButton />}
      </div>
    </ActionForm>
  );
}

function SwitchButton() {
  const { pending } = useFormStatus();
  return (
    <div className="shrink-0 space-y-1">
      <SubmitButton size="sm" className="h-9 w-full">
        Switch organization
      </SubmitButton>
      <p role="status" className="sr-only">
        {pending ? "Switching organization…" : ""}
      </p>
    </div>
  );
}
