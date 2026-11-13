"use client";

import { type ConnectionPreset, MAX_CONNECTION_MODELS, presetModels } from "@armada/core";
import { type ReactNode, useId, useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { catalogPriceLabel, visibleCatalogModels } from "@/lib/connection-presets";

/**
 * A provider-preset connection (#1483): the address (shown when the provider has a fixed one), the key, and the
 * models, ticked from the catalog or typed. Ticked models travel as hidden fields so a search never drops one.
 * The key stays an uncontrolled password input; prices are looked up on the server, never sent from here.
 */
export function PresetConnectionFields({ preset, secretField }: { preset: ConnectionPreset; secretField: ReactNode }) {
  const id = useId();
  const catalog = presetModels(preset);
  const [ticked, setTicked] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const tickedSet = useMemo(() => new Set(ticked), [ticked]);
  const rows = visibleCatalogModels(catalog, query, tickedSet);
  const full = ticked.length >= MAX_CONNECTION_MODELS;
  const toggle = (model: string, on: boolean) =>
    setTicked((current) => (on ? [...current, model] : current.filter((value) => value !== model)));

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {preset.baseUrl ? (
          <>
            <p className="text-sm font-medium">Address</p>
            <p className="rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs break-all">{preset.baseUrl}</p>
          </>
        ) : (
          <>
            <Label htmlFor={`${id}-base-url`}>Address</Label>
            <Input
              id={`${id}-base-url`}
              name="baseUrl"
              type="url"
              required
              spellCheck={false}
              autoComplete="off"
              aria-describedby={`${id}-base-url-hint`}
              placeholder={preset.addressPlaceholder}
            />
            {preset.addressHint && (
              <p id={`${id}-base-url-hint`} className="text-xs text-muted-foreground">
                {preset.addressHint}
              </p>
            )}
          </>
        )}
      </div>
      {preset.apiVersion && (
        <div className="space-y-2">
          <Label htmlFor={`${id}-api-version`}>API version (optional)</Label>
          <Input
            id={`${id}-api-version`}
            name="apiVersion"
            autoComplete="off"
            spellCheck={false}
            placeholder="Not needed for Foundry v1"
          />
        </div>
      )}
      {secretField}
      <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm font-medium">Models</legend>
        {ticked.map((model) => (
          <input key={model} type="hidden" name="model" value={model} />
        ))}
        {catalog.length > 0 && (
          <>
            <Input
              type="search"
              aria-label="Search models"
              placeholder={`Search ${catalog.length} known models`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
              {rows.map((model) => {
                const checked = tickedSet.has(model.id);
                const price = catalogPriceLabel(model);
                return (
                  <li key={model.id}>
                    <Label
                      htmlFor={`${id}-model-${model.id}`}
                      className="flex cursor-pointer items-start gap-3 px-3 py-2 font-normal hover:bg-accent/50"
                    >
                      <Checkbox
                        id={`${id}-model-${model.id}`}
                        checked={checked}
                        disabled={!checked && full}
                        onCheckedChange={(value) => toggle(model.id, value === true)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{model.name}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">{model.id}</span>
                      </span>
                      <span className="shrink-0 text-right text-xs text-muted-foreground">
                        {price ?? "Price unknown"}
                      </span>
                    </Label>
                  </li>
                );
              })}
              {rows.length === 0 && (
                <li className="px-3 py-2 text-sm text-muted-foreground">No known model matches.</li>
              )}
            </ul>
          </>
        )}
        <div className="space-y-2">
          <Label htmlFor={`${id}-custom-models`} className="text-sm font-normal">
            {catalog.length > 0 ? "Other model IDs (optional)" : "Model IDs"}
          </Label>
          <Textarea
            id={`${id}-custom-models`}
            name="customModels"
            rows={2}
            required={catalog.length === 0}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
            placeholder={preset.id === "azure-foundry" ? "your-deployment-name" : "model-id, another-model-id"}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {ticked.length} ticked, up to {MAX_CONNECTION_MODELS} in all. Prices are models.dev public prices; a model
          typed by hand has no known price.
        </p>
      </fieldset>
    </div>
  );
}
