import { type ComponentProps, Suspense } from "react";
import { IngredientLink } from "@/components/ingredient-link";
import { PanelSection } from "@/components/state-cell";
import { listSelectedTemplates } from "@/lib/data/templates";
import type { TemplateDefinition } from "@/lib/templates";

type Props = ComponentProps<"section"> & {
  uses: (definition: TemplateDefinition) => boolean;
  empty?: string;
  note?: string;
};

/** Caller-visible current revisions, including blocked launches; missing reads never become zero usage. */
export function TemplateUsage(props: Props) {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-xs text-muted-foreground">
          Loading template usage…
        </p>
      }
    >
      <Usage {...props} />
    </Suspense>
  );
}

async function Usage({
  uses,
  title = "Templates",
  empty = "No visible templates use this resource.",
  note,
  ...props
}: Props) {
  const list = await listSelectedTemplates();
  if (list.state !== "ready")
    return (
      <PanelSection title={title} {...props}>
        <p className="text-xs text-muted-foreground">Template usage could not be read.</p>
      </PanelSection>
    );
  const partial = list.items.some((item) => item.revision === null);
  const matches = list.items.filter((item) => item.revision && uses(item.revision.definition));
  return (
    <PanelSection title={title} data-template-usage {...props}>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <p className="text-xs text-muted-foreground">
        {matches.length
          ? `Used by ${partial ? "at least " : ""}${matches.length} visible ${matches.length === 1 ? "template" : "templates"}.`
          : partial
            ? "No matches in the revisions that could be read."
            : empty}
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
