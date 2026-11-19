"use client";

import type { MachineSize, MachineSizePolicy, SandboxProviderId } from "@armada/core";
import { useState } from "react";
import { ChoiceChip } from "@/components/launch-composer";
import {
  DEFAULT_SIZE,
  defaultOptionLabel,
  describeDefault,
  launchDefault,
  MACHINE_SIZE_LABELS,
  sizeCaveat,
  sizeOptions,
  sizeSpec,
} from "@/lib/machine-size";

export function MachineSizeField({
  provider,
  policy,
  repositoryDir,
}: {
  provider: SandboxProviderId;
  policy: MachineSizePolicy | null;
  repositoryDir: string;
}) {
  const [override, setOverride] = useState<MachineSize | typeof DEFAULT_SIZE>(DEFAULT_SIZE);
  const resolved = launchDefault(provider, policy, repositoryDir);
  const chosen = override || resolved.effective;
  return (
    <>
      <input type="hidden" name="size" value={override} />
      <ChoiceChip
        title="Machine size"
        label={`Machine · ${chosen ? MACHINE_SIZE_LABELS[chosen] : "Provider default"}`}
        value={override}
        options={[{ value: DEFAULT_SIZE, label: defaultOptionLabel(provider, resolved) }, ...sizeOptions(provider)]}
        onChange={(value) => setOverride(value as MachineSize | typeof DEFAULT_SIZE)}
      >
        <p className="border-t p-2 text-sm text-muted-foreground" data-size-source={resolved.source}>
          {override
            ? `Overrides the default (${describeDefault(provider, resolved)}).`
            : `${describeDefault(provider, resolved)}.`}
          {chosen ? ` ${sizeSpec(provider, chosen)}.` : null}
          {sizeCaveat(provider, chosen)}
        </p>
      </ChoiceChip>
    </>
  );
}
