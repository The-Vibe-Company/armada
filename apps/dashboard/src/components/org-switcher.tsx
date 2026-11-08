"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useFormStatus } from "react-dom";
import { switchOrganization } from "@/app/actions/selected-org";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { Membership } from "@/lib/data/viewer";

export function OrgSwitcher({ memberships, selected }: { memberships: Membership[]; selected: string | null }) {
  const pathname = usePathname();
  return (
    <div className="space-y-2 px-4 pb-4">
      {selected ? (
        <ActionForm action={switchOrganization} className="space-y-2">
          <Label htmlFor="active-org">Active organization</Label>
          <NativeSelect key={selected} id="active-org" name="org" defaultValue={selected}>
            {memberships.map(({ org }) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </NativeSelect>
          <input type="hidden" name="section" value={pathname.split("/")[1]} />
          {memberships.length > 1 && <SwitchButton />}
        </ActionForm>
      ) : (
        <p className="text-sm text-muted-foreground">
          No organization yet.{" "}
          <Link className="underline" href="/orgs">
            Create an organization
          </Link>
        </p>
      )}
    </div>
  );
}

function SwitchButton() {
  const { pending } = useFormStatus();
  return (
    <div className="space-y-1">
      <SubmitButton variant="outline" size="sm">
        Switch organization
      </SubmitButton>
      <p role="status" className="text-xs text-muted-foreground">
        {pending ? "Switching organization…" : ""}
      </p>
    </div>
  );
}
