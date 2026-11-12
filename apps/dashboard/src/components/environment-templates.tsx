import type { SandboxProviderId } from "@armada/core";
import { TemplateUsage } from "@/components/template-usage";
import type { TemplateList } from "@/lib/data/templates";

export function EnvironmentTemplates({
  list,
  goldenId,
  provider,
}: {
  list: TemplateList;
  goldenId: string;
  provider: SandboxProviderId;
}) {
  return (
    <TemplateUsage
      list={list}
      uses={(definition) => definition.goldenId === goldenId && definition.provider === provider}
      empty="No visible templates use this environment."
      data-environment-templates
    />
  );
}
