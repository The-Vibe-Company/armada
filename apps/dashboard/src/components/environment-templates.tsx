import type { SandboxProviderId } from "@armada/core";
import { IngredientLink } from "@/components/ingredient-link";
import { PanelSection } from "@/components/state-cell";
import type { TemplateList } from "@/lib/data/templates";

/** Current, caller-visible revisions only; never infer usage from launch readiness or historical revisions. */
export function EnvironmentTemplates({
  list,
  goldenId,
  provider,
}: {
  list: TemplateList;
  goldenId: string;
  provider: SandboxProviderId;
}) {
  if (list.state !== "ready")
    return (
      <PanelSection title="Templates">
        <p className="text-xs text-muted-foreground">Template usage could not be read.</p>
      </PanelSection>
    );
  const partial = list.items.some((item) => item.revision === null);
  const matches = list.items.filter(
    (item) => item.revision?.definition.goldenId === goldenId && item.revision.definition.provider === provider,
  );
  return (
    <PanelSection title="Templates" data-environment-templates>
      <p className="text-xs text-muted-foreground">
        {matches.length
          ? `Used by ${partial ? "at least " : ""}${matches.length} visible ${matches.length === 1 ? "template" : "templates"}.`
          : partial
            ? "No matches in the revisions that could be read."
            : "No visible templates use this environment."}
      </p>
      {matches.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {matches.map((item) => (
            <li key={item.id} className="min-w-0 max-w-full">
              <IngredientLink href={`/templates?item=${encodeURIComponent(item.id)}`}>{item.name}</IngredientLink>
            </li>
          ))}
        </ul>
      )}
      {partial && <p className="text-xs text-muted-foreground">Some template revisions could not be read.</p>}
    </PanelSection>
  );
}
