"use client";

import type { Harness, HarnessModels } from "@armada/core";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { EFFORT_LABEL } from "@/lib/labels";

export type ModelCatalog = Readonly<Record<Harness, HarnessModels>>;

/** Must match `OTHER_MODEL` in `@/lib/model-choice`, which reads the form on the server. */
const OTHER_MODEL = "other";

export { EFFORT_LABEL };

/**
 * The model and reasoning effort selects of a launch or a send. The suggested models of the harness are
 * listed; "Other model id" takes any other id, which the server checks. With `keepLabel` both start on an
 * empty choice that keeps what the sandbox was launched with.
 */
export function ModelFields({
  idPrefix,
  harness,
  catalog,
  keepLabel,
  launchedModel,
  onChoice,
  initial,
}: {
  idPrefix: string;
  harness: Harness;
  catalog: ModelCatalog;
  keepLabel?: string;
  launchedModel?: string | null;
  /** The model id and effort that will be sent, as they change: what a compact summary shows. */
  onChoice?: (choice: { model: string; effort: string }) => void;
  /** Start on this choice instead of the harness default (a template's revision being edited). */
  initial?: { model: string; effort: string };
}) {
  const entry = catalog[harness];
  // A model the catalog does not list starts as "Other model id", its id in the field.
  const initialListed = initial ? entry.models.some((option) => option.id === initial.model) : true;
  const initialModel = keepLabel ? "" : initial ? (initialListed ? initial.model : OTHER_MODEL) : entry.defaultModel;
  const initialEffort = keepLabel ? "" : (initial?.effort ?? entry.defaultReasoningEffort);
  const initialOther = initial && !initialListed ? initial.model : "";
  const [model, setModel] = useState(initialModel);
  const [effort, setEffort] = useState(initialEffort);
  const [otherModel, setOtherModel] = useState(initialOther);
  const group = useRef<HTMLDivElement>(null);
  const selectedModel = model === OTHER_MODEL ? otherModel.trim() : model || launchedModel;
  const efforts =
    entry.models.find((option) => option.id === selectedModel)?.reasoningEfforts ?? entry.reasoningEfforts;
  const effortPlaceholder =
    !model || selectedModel === launchedModel
      ? keepLabel
      : `Default for selected model (${entry.defaultReasoningEffort})`;

  useEffect(() => onChoice?.({ model: selectedModel ?? "", effort }), [onChoice, selectedModel, effort]);

  // Native reset changes DOM fields; the controlled state must reset with them.
  useEffect(() => {
    const form = group.current?.closest("form");
    const reset = () => {
      setModel(initialModel);
      setEffort(initialEffort);
      setOtherModel(initialOther);
    };
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, [initialModel, initialEffort, initialOther]);

  function chooseModel(next: string) {
    setModel(next);
    const nextModel = next === OTHER_MODEL ? otherModel.trim() : next || launchedModel;
    const allowed = entry.models.find((option) => option.id === nextModel)?.reasoningEfforts ?? entry.reasoningEfforts;
    if (effort && !allowed.includes(effort)) setEffort(keepLabel ? "" : entry.defaultReasoningEffort);
  }

  return (
    <div ref={group} className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-model`}>Model</Label>
        <NativeSelect
          id={`${idPrefix}-model`}
          name="model"
          value={model}
          onChange={(event) => chooseModel(event.target.value)}
        >
          {keepLabel && <option value="">{keepLabel}</option>}
          {entry.models.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
              {option.id === entry.defaultModel ? " (default)" : ""}
            </option>
          ))}
          <option value={OTHER_MODEL}>Other model id</option>
        </NativeSelect>
        {model === OTHER_MODEL && (
          <Input
            name="other_model"
            value={otherModel}
            onChange={(event) => setOtherModel(event.target.value)}
            aria-label="Model id"
            required
            autoComplete="off"
            spellCheck={false}
            placeholder={harness === "claude" ? "claude-…" : "gpt-…"}
          />
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-effort`}>Reasoning effort</Label>
        <NativeSelect
          id={`${idPrefix}-effort`}
          name="reasoning_effort"
          value={effort}
          onChange={(event) => setEffort(event.target.value)}
        >
          {keepLabel && <option value="">{effortPlaceholder}</option>}
          {efforts.map((level) => (
            <option key={level} value={level}>
              {EFFORT_LABEL[level] ?? level}
              {level === entry.defaultReasoningEffort && !keepLabel ? " (default)" : ""}
            </option>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}
