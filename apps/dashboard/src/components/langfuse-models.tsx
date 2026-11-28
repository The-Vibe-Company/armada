"use client";

import { ChevronRightIcon } from "lucide-react";
import { type ComponentProps, type FormEvent, type ReactNode, useId, useState, useTransition } from "react";
import * as api from "@/app/actions/langfuse";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as lf from "@/lib/langfuse";
import { cn } from "@/lib/utils";

type P = lf.LangfuseTokenPricesPerMillion;
type Draft = { title: string; v: Record<string, string>; replaceId: string | null };
const STATUS = {
  matched_builtin: ["Matched in Langfuse", "secondary"],
  matched_custom: ["Custom override", "outline"],
  unmatched: ["Unmatched", "destructive"],
} as const;
const FIELDS =
  "modelName:Model name:1:0|matchPattern:Match pattern:1:1|input:Input (USD / 1M):1:2|output:Output (USD / 1M):1:2|cacheRead:Cache read (USD / 1M):0:2|cacheWrite:Cache write (USD / 1M):0:2|reasoning:Reasoning (USD / 1M):0:2"
    .split("|")
    .map((s) => s.split(":"));
const Btn = (p: ComponentProps<typeof Button>) => <Button type="button" variant="outline" size="sm" {...p} />;
const RATE_LABELS = "input:In|output:Out|cacheRead:Cache read|cacheWrite:Cache write|reasoning:Reasoning"
  .split("|")
  .map((s) => s.split(":") as [keyof P, string]);
const rates = (p: P) =>
  `${RATE_LABELS.flatMap(([k, l]) => (p[k] === null ? [] : [`${l} ${lf.formatUsdPerMillion(p[k])}`])).join(" · ")} / 1M`;

export function LangfuseModelsPanel({ org }: { org: string }) {
  const id = useId();
  const [summary, setSummary] = useState<lf.LangfuseModelsSummary | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, start] = useTransition();
  const [act, setAct] = useState<string | null>(null);

  const run = (k: string, fn: () => Promise<void>) => {
    setError("");
    if (k !== "load") setNotice("");
    setAct(k);
    start(async () => {
      try {
        await fn();
      } catch {
        setError("Armada could not complete the Langfuse request. Try again.");
      } finally {
        setAct(null);
      }
    });
  };
  const load = () =>
    run("load", async () => {
      const r = await api.loadLangfuseModels(org);
      r.ok ? setSummary(r.data) : setError(r.error);
    });
  const sync = () =>
    run("sync", async () => {
      const r = await api.syncLangfuseModels(org);
      if (!r.ok) return setError(r.error);
      setSummary({ armadaModels: r.data.armadaModels, customModels: r.data.customModels });
      const f = r.data.failed.length ? `, ${r.data.failed.length} failed` : "";
      setNotice(`Synced: ${r.data.created.length} created, ${r.data.skipped.length} skipped${f}.`);
    });
  const del = (modelId: string) =>
    run(`del:${modelId}`, async () => {
      const r = await api.deleteLangfuseModelOverride(org, modelId);
      if (!r.ok) return setError(r.error);
      const next = await api.loadLangfuseModels(org);
      next.ok ? setSummary(next.data) : setError(next.error);
    });
  const close = () => {
    setDraft(null);
    setError("");
  };
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    run("save", async () => {
      const r = await api.saveLangfuseModelOverride(org, form);
      if (!r.ok) return setError(r.error);
      setSummary({ armadaModels: r.data.armadaModels, customModels: r.data.customModels });
      setDraft(null);
    });
  };
  const show = (
    title: string,
    seed?: { modelName: string; matchPattern: string; pricesPerMillion: P | null; id: string | null },
  ) => {
    setError("");
    const p = seed?.pricesPerMillion;
    const s = (k: keyof P) => (p === null || p === undefined || p[k] === null ? "" : String(p[k]));
    const ps = Object.fromEntries(RATE_LABELS.map(([k]) => [k, s(k)]));
    setDraft({
      title,
      v: { modelName: seed?.modelName ?? "", matchPattern: seed?.matchPattern ?? "", ...ps },
      replaceId: seed?.id ?? null,
    });
  };
  const openArmada = (m: lf.LangfuseArmadaModelStatus) => {
    const c = m.matchedModel && !m.matchedModel.isLangfuseManaged ? m.matchedModel : null;
    const pricesPerMillion = c?.pricesPerMillion ?? m.matchedModel?.pricesPerMillion ?? m.suggestedPricesPerMillion;
    const [modelName, matchPattern] = [c?.modelName ?? m.defaultModelName, c?.matchPattern ?? m.defaultMatchPattern];
    show(`Override ${m.label}`, { modelName, matchPattern, pricesPerMillion, id: c?.id ?? null });
  };
  const row = (k: string, title: string, meta: string, detail: string, btns: ReactNode, st?: keyof typeof STATUS) => (
    <li key={k} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          {st && <Badge variant={STATUS[st][1]}>{STATUS[st][0]}</Badge>}
          <span className="break-all font-mono text-xs text-muted-foreground">{meta}</span>
        </div>
        <p className="text-xs tabular-nums text-muted-foreground">{detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{btns}</div>
    </li>
  );
  const total = summary?.armadaModels.length ?? 0;
  const unmatched = summary?.armadaModels.filter((m) => m.status === "unmatched").length ?? 0;
  const matched = total - unmatched;
  const msg = notice || (!summary && pending ? "Loading model pricing…" : "");

  return (
    <details
      onToggle={(e) => e.currentTarget.open && !summary && !pending && load()}
      className="group border-t px-4 py-3"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-1.5">
          <ChevronRightIcon
            aria-hidden
            className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
          />
          Model pricing
        </span>
        <span className="text-xs font-normal tabular-nums text-muted-foreground">
          {summary ? `${matched} matched · ${unmatched} unmatched` : "Expand to inspect and sync model prices"}
        </span>
      </summary>
      <div className="space-y-3 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs tabular-nums text-muted-foreground">
            {summary ? `${matched} of ${total} matched · ${unmatched} unmatched` : "USD per 1M tokens"}
          </p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["load", load, act === "load" ? "Refreshing…" : "Refresh"],
                ["sync", sync, act === "sync" ? "Syncing…" : "Sync missing prices"],
                ["add", () => show("Add model price override"), "Add override"],
              ] as const
            ).map(([k, fn, label]) => (
              <Btn key={k} onClick={fn} disabled={pending}>
                {label}
              </Btn>
            ))}
          </div>
        </div>
        {msg && (
          <p role="status" className="text-xs text-muted-foreground">
            {msg}
          </p>
        )}
        {!draft && error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {summary && (
          <>
            <h4 className="text-xs font-medium text-muted-foreground">Armada models</h4>
            <ul className="divide-y rounded-lg border">
              {summary.armadaModels.map((m) => {
                const p = m.matchedModel?.pricesPerMillion ?? null;
                const s = m.suggestedPricesPerMillion;
                const fallback = s ? `Suggested (${s.source}): ${rates(s)}` : "No active price";
                return row(
                  m.id,
                  m.label,
                  m.defaultModelName,
                  p ? rates(p) : fallback,
                  <Btn disabled={pending} onClick={() => openArmada(m)}>
                    Override
                  </Btn>,
                  m.status,
                );
              })}
            </ul>
            <h4 className="text-xs font-medium tabular-nums text-muted-foreground">
              Custom overrides ({summary.customModels.length})
            </h4>
            {!summary.customModels.length ? (
              <p className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">No custom overrides yet.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {summary.customModels.map((m) =>
                  row(
                    m.id,
                    m.modelName,
                    m.matchPattern,
                    rates(m.pricesPerMillion),
                    <>
                      <Btn disabled={pending} onClick={() => show(`Edit ${m.modelName}`, m)}>
                        Edit
                      </Btn>
                      <Btn variant="destructive-outline" disabled={pending} onClick={() => del(m.id)}>
                        {act === `del:${m.id}` ? "Deleting…" : "Delete"}
                      </Btn>
                    </>,
                  ),
                )}
              </ul>
            )}
          </>
        )}
      </div>
      <Dialog open={Boolean(draft)} onOpenChange={(v) => !pending && !v && close()}>
        <DialogContent data-create-dialog className="sm:max-w-lg">
          <DialogHeader className="text-left">
            <DialogTitle>{draft?.title ?? "Model price override"}</DialogTitle>
            <DialogDescription>Custom USD per 1M token prices (regex supports optional (?i) prefix).</DialogDescription>
          </DialogHeader>
          {draft && (
            <form className="space-y-4" onSubmit={save} aria-busy={pending}>
              {draft.replaceId && <input type="hidden" name="replaceModelId" value={draft.replaceId} />}
              <fieldset disabled={pending} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {FIELDS.map(([k = "", lbl = "", r = "", kind = ""]) => {
                  const num = kind === "2";
                  const className = ({ "1": "font-mono", "2": "tabular-nums" } as Record<string, string>)[kind];
                  const placeholder = ({ "12": "0.00", "02": "Optional" } as Record<string, string>)[`${r}${kind}`];
                  const inputMode = num ? ("decimal" as const) : undefined;
                  const ip = { id: `${id}-${k}`, name: k, required: r === "1", defaultValue: draft.v[k] ?? "" };
                  return (
                    <div key={k} className={cn("space-y-1.5", !num && "sm:col-span-2")}>
                      <Label htmlFor={ip.id}>{lbl}</Label>
                      <Input {...ip} inputMode={inputMode} placeholder={placeholder} className={className} />
                    </div>
                  );
                })}
              </fieldset>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
                <Btn onClick={close} disabled={pending}>
                  Cancel
                </Btn>
                <Button type="submit" disabled={pending}>
                  {pending ? "Saving…" : "Save override"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </details>
  );
}
