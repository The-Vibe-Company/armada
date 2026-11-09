"use client";

import type { SandboxProviderId } from "@armada/core";
import { useId } from "react";
import { saveSizePolicy } from "@/app/actions/goldens";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PROVIDER_LABELS } from "@/lib/golden-form";
import { type GoldenSizing, policySummary, sizeOptions } from "@/lib/machine-size";

/**
 * A golden's machine size defaults: one for the golden and one per configured repository, the repository's winning
 * when it is the launch's working directory. Read-only with the reason when the viewer may not change them.
 */
export function SizeDefaults({
  goldenId,
  orgId,
  provider,
  directories,
  sizing,
  blocker,
}: {
  goldenId: string;
  orgId: string;
  provider: SandboxProviderId;
  directories: readonly string[];
  sizing: Exclude<GoldenSizing, { kind: "unsupported" }>;
  /** Why the viewer cannot edit, or null. */
  blocker: string | null;
}) {
  const id = useId();
  if (sizing.kind === "unreadable") {
    return (
      <p role="alert" className="text-xs text-destructive" data-size-defaults="unreadable">
        Stored size defaults could not be read: {sizing.reason} Launches from this golden fail until they are fixed.
      </p>
    );
  }
  const policy = sizing.policy;
  const summary = <span data-size-summary>{policySummary(provider, policy)}</span>;
  if (blocker) {
    return (
      <p className="text-xs text-muted-foreground" data-size-defaults="read-only">
        Size defaults: {summary}. {blocker}
      </p>
    );
  }
  return (
    <details data-size-defaults="editable">
      <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
        Machine size defaults <span className="font-normal">· {summary}</span>
      </summary>
      <ActionForm action={saveSizePolicy} className="space-y-3 pt-3">
        <input type="hidden" name="golden" value={goldenId} />
        <input type="hidden" name="org" value={orgId} />
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Keyed by the stored value: after a save the page's new defaults replace the reset form's old ones. */}
          <SizeSelect
            key={`golden-${policy?.golden ?? ""}`}
            id={`${id}-golden`}
            name="golden_size"
            label="Golden default"
            provider={provider}
            value={policy?.golden ?? ""}
          />
          {directories.map((dir) => (
            <SizeSelect
              key={`${dir}-${policy?.repositories[dir] ?? ""}`}
              id={`${id}-${dir}`}
              name={`size:${dir}`}
              label={`When starting in ${dir}`}
              provider={provider}
              value={policy?.repositories[dir] ?? ""}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          A repository's default wins over the golden's; a launch can still choose another size. Saving applies to the
          next launch: it does not rebuild the golden or restart a sandbox. The {PROVIDER_LABELS[provider]} golden keeps
          its own defaults, apart from a same-name golden on another provider.
        </p>
        <SubmitButton variant="outline" size="sm">
          Save size defaults
        </SubmitButton>
      </ActionForm>
    </details>
  );
}

function SizeSelect({
  id,
  name,
  label,
  provider,
  value,
}: {
  id: string;
  name: string;
  label: string;
  provider: SandboxProviderId;
  value: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <NativeSelect id={id} name={name} defaultValue={value}>
        <option value="">No default</option>
        {sizeOptions(provider).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
