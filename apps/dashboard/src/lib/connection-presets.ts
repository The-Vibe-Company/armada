/** Pure presentation rules for the provider-preset connection form (#1483). */
import type { CatalogModel } from "@armada/core";

/** The rows a model list shows: every ticked model first, then the matches of the query, at most `limit` in all. */
export function visibleCatalogModels(
  models: readonly CatalogModel[],
  query: string,
  ticked: ReadonlySet<string>,
  limit = 40,
): CatalogModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (model: CatalogModel) => {
    const text = `${model.id} ${model.name}`.toLowerCase();
    return words.every((word) => text.includes(word));
  };
  const chosen = models.filter((model) => ticked.has(model.id));
  const rest = models.filter((model) => !ticked.has(model.id) && matches(model));
  return [...chosen, ...rest.slice(0, Math.max(0, limit - chosen.length))];
}

/** "$0.15 in · $0.6 out per M tokens", or null when either price is unknown. */
export function catalogPriceLabel(model: Pick<CatalogModel, "input" | "output">): string | null {
  if (model.input === null || model.output === null) return null;
  return `$${model.input} in · $${model.output} out per M tokens`;
}
