import type { SandboxProviderId } from "@armada/core";
import { TemplateUsage } from "@/components/template-usage";

export function EnvironmentTemplates({ goldenId, provider }: { goldenId: string; provider: SandboxProviderId }) {
  return (
    <TemplateUsage
      uses={(definition) => definition.goldenId === goldenId && definition.provider === provider}
      empty="No visible templates use this snapshot."
      data-environment-templates
    />
  );
}
