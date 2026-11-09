"use client";

import type { MachineSize, MachineSizePolicy, SandboxProviderId } from "@armada/core";
import { useEffect, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  DEFAULT_SIZE,
  defaultOptionLabel,
  describeDefault,
  launchDefault,
  sizeCaveat,
  sizeOptions,
  sizeSpec,
} from "@/lib/machine-size";

/**
 * The machine size of a launch. It starts on the resolved default (the selected repository's, then the golden's,
 * then the provider's own) and follows the working directory until the person picks a size; from then on their
 * override stays whatever else changes, until the form is reset.
 */
export function MachineSizeField({
  idPrefix,
  provider,
  policy,
  repositoryDir,
}: {
  idPrefix: string;
  provider: SandboxProviderId;
  policy: MachineSizePolicy | null;
  /** The selected working directory, empty for none. */
  repositoryDir: string;
}) {
  const [override, setOverride] = useState<MachineSize | typeof DEFAULT_SIZE>(DEFAULT_SIZE);
  const group = useRef<HTMLDivElement>(null);
  const resolved = launchDefault(provider, policy, repositoryDir);
  const chosen = override || resolved.effective;
  const caveat = sizeCaveat(provider, chosen);

  // Native reset after a launch attempt empties the DOM; the controlled state must follow it.
  useEffect(() => {
    const form = group.current?.closest("form");
    const reset = () => setOverride(DEFAULT_SIZE);
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, []);

  return (
    <div ref={group} className="space-y-2" data-machine-size>
      <Label htmlFor={`${idPrefix}-size`}>Machine size</Label>
      <NativeSelect
        id={`${idPrefix}-size`}
        name="size"
        value={override}
        onChange={(event) => setOverride(event.target.value as MachineSize | typeof DEFAULT_SIZE)}
        aria-describedby={`${idPrefix}-size-hint`}
      >
        <option value={DEFAULT_SIZE}>{defaultOptionLabel(provider, resolved)}</option>
        {sizeOptions(provider).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
      <p id={`${idPrefix}-size-hint`} className="text-xs text-muted-foreground" data-size-source={resolved.source}>
        {override
          ? `Overrides the default (${describeDefault(provider, resolved)}).`
          : `${describeDefault(provider, resolved)}.`}
        {chosen ? ` ${sizeSpec(provider, chosen)}.` : null}
        {caveat ? ` ${caveat}` : null}
      </p>
    </div>
  );
}
