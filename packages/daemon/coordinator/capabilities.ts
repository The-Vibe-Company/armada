/** Recovery text is shared by status, refusals and their durable follow-ups. */
export const launchFix = "Enable Conductor, Claude, Codex or OpenCode in Settings › Providers";

export const capabilityGap = (capability: string, reason: string, fix: string) => ({ capability, reason, fix });

export function providerFix(capability: string, enabled = false) {
  const provider = capability.split(".").at(-1) ?? capability;
  return enabled
    ? `Restart Armada to load ${provider} after enabling it in Settings › Providers`
    : `Enable ${provider} in Settings › Providers`;
}
