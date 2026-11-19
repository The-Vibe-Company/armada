"use client";

import type { MachineSize, MachineSizePolicy, SandboxProviderId } from "@armada/core";
import { useEffect, useRef, useState } from "react";
import { LaunchChoice, LaunchSetting } from "@/components/launch-surface";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
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
  onSize,
  composer = false,
}: {
  composer?: boolean;
  idPrefix: string;
  provider: SandboxProviderId;
  policy: MachineSizePolicy | null;
  /** The selected working directory, empty for none. */
  repositoryDir: string;
  /** The size that will be requested as it changes, null while the provider decides: what a summary shows. */
  onSize?: (size: MachineSize | null) => void;
}) {
  const [override, setOverride] = useState<MachineSize | typeof DEFAULT_SIZE>(DEFAULT_SIZE);
  const group = useRef<HTMLDivElement>(null);
  const resolved = launchDefault(provider, policy, repositoryDir);
  const chosen = override || resolved.effective;
  const caveat = sizeCaveat(provider, chosen);
  useEffect(() => onSize?.(chosen || null), [onSize, chosen]);

  // Native reset after a launch attempt empties the DOM; the controlled state must follow it.
  useEffect(() => {
    const form = group.current?.closest("form");
    const reset = () => setOverride(DEFAULT_SIZE);
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, []);

  return (
    <div ref={group} className="space-y-2" data-machine-size>
      {composer ? (
        <>
          <input type="hidden" name="size" value={override} />
          <LaunchSetting
            label="Machine"
            value={chosen ? MACHINE_SIZE_LABELS[chosen] : "Provider default"}
            description={`${chosen ? sizeSpec(provider, chosen) + " · " : ""}${override ? "launch override" : describeDefault(provider, resolved)}`}
          >
            <LaunchChoice
              label="Machine size"
              value={override}
              options={[
                { value: DEFAULT_SIZE, label: defaultOptionLabel(provider, resolved) },
                ...sizeOptions(provider),
              ]}
              onChange={(value) => setOverride(value as MachineSize | typeof DEFAULT_SIZE)}
            />
          </LaunchSetting>
        </>
      ) : (
        <>
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
        </>
      )}
      <p
        hidden={composer}
        id={`${idPrefix}-size-hint`}
        className="text-xs text-muted-foreground"
        data-size-source={resolved.source}
      >
        {override
          ? `Overrides the default (${describeDefault(provider, resolved)}).`
          : `${describeDefault(provider, resolved)}.`}
        {chosen ? ` ${sizeSpec(provider, chosen)}.` : null}
        {caveat ? ` ${caveat}` : null}
      </p>
    </div>
  );
}
