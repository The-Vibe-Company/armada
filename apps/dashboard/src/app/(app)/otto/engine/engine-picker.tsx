"use client";

import { HARNESS_CATALOG, HARNESSES, type Harness, type OttoEngine, type OttoEnginePreflight } from "@armada/core";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export function EnginePicker({
  initial,
  accounts,
  preflight,
  save,
}: {
  initial: OttoEngine | null;
  accounts: { id: string; name: string; kind: string; models?: string[]; status: string }[];
  preflight: OttoEnginePreflight | null;
  save: (engine: OttoEngine) => Promise<OttoEnginePreflight>;
}) {
  const [harness, setHarness] = useState<Harness | "">(initial?.harness ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [credentialId, setAccount] = useState(initial?.credentialId ?? "");
  const [result, setResult] = useState(preflight);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const field = "mt-2 w-full rounded-md border bg-background p-2 text-sm";
  return (
    <form
      className="max-w-lg space-y-5"
      onChange={() => {
        setResult(null);
        setSaved(false);
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!harness) return;
        setPending(true);
        try {
          const next = await save({ harness, model, credentialId });
          setResult(next);
          setSaved(next.ready);
        } finally {
          setPending(false);
        }
      }}
    >
      <div>
        <Label htmlFor="engine-harness">Harness</Label>
        <select
          disabled={pending}
          required
          id="engine-harness"
          className={field}
          value={harness}
          onChange={(e) => {
            setHarness(e.target.value as Harness);
            setModel("");
            setAccount("");
          }}
        >
          <option value="">Choose a harness</option>
          {HARNESSES.map((id) => (
            <option key={id} value={id}>
              {HARNESS_CATALOG[id].label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor="engine-model">Model</Label>
        <input
          disabled={pending}
          required
          id="engine-model"
          list="engine-models"
          className={field}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Choose or enter a model ID"
        />
        <datalist id="engine-models">
          {harness &&
            (
              accounts.find((a) => a.id === credentialId)?.models?.map((id) => ({ id, label: id })) ??
              HARNESS_CATALOG[harness].models
            ).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
        </datalist>
      </div>
      <div>
        <Label htmlFor="engine-account">Model account</Label>
        <select
          disabled={pending}
          required
          id="engine-account"
          className={field}
          value={credentialId}
          onChange={(e) => setAccount(e.target.value)}
        >
          <option value="">Choose an account</option>
          {accounts
            .filter((a) => harness && (HARNESS_CATALOG[harness].credentialKinds as readonly string[]).includes(a.kind))
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name || a.kind} ({a.status})
              </option>
            ))}
          {credentialId && !accounts.some((a) => a.id === credentialId) && (
            <option value={credentialId}>Unavailable account</option>
          )}
        </select>
        <Link href="/harness" className="mt-2 inline-block text-sm underline">
          Connect a model account
        </Link>
      </div>
      <Button disabled={pending} type="submit">
        {pending ? "Checking access…" : "Check access and save"}
      </Button>
      {result && (
        <p role="status" className="text-sm">
          {result.ready
            ? saved
              ? "Engine saved. No attempt launched."
              : "Saved engine is available. No attempt launched."
            : result.message}
          {!result.ready && result.connectUrl && (
            <>
              {" "}
              <Link href={result.connectUrl} className="underline">
                Connect account
              </Link>
            </>
          )}
        </p>
      )}
    </form>
  );
}
