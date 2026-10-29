import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { useDaemon, useDaemonClient } from "@/protocol/store";

/** A key lives only in the password field until one explicit submit. Never in app state/storage. */
export function CoordinatorKey() {
  const { credentials, status, plugins } = useDaemon();
  const client = useDaemonClient();
  const field = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!credentials) return null;
  const catalog = plugins?.plugins;
  const hasCatalog =
    credentials.models !== undefined ||
    catalog?.some((plugin) => plugin.contributions.some((entry) => entry.seam === "model")) === true;
  const models =
    catalog && hasCatalog
      ? catalog.flatMap((plugin) =>
          plugin.loaded
            ? plugin.contributions
                .filter((entry) => entry.seam === "model")
                .map((entry) => ({
                  kind: entry.kind,
                  description: entry.description ?? entry.kind,
                  config: credentials.models?.find((model) => model.kind === entry.kind)?.config ?? entry.schema,
                }))
            : [],
        )
      : (credentials.models ?? []);
  const chosen = models.find((entry) => entry.kind === (selected ?? credentials.provider)) ?? models[0];
  const schema = chosen?.config as
    | { required?: string[]; properties?: Record<string, { default?: string }> }
    | undefined;
  const defaults = schema?.properties ?? {};
  const savedConfig = chosen?.kind === credentials.provider ? credentials.config : undefined;
  const provider = models.find((entry) => entry.kind === credentials.provider)?.description ?? credentials.provider;
  const saved = credentials.provider !== null && !editing;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setSaving(true);
    setProblem(null);
    const model = String(values.get("model") ?? "").trim();
    const baseURL = String(values.get("baseURL") ?? "").trim();
    const request = client.saveCredentials(String(values.get("provider")), String(values.get("key")), {
      ...(model ? { model } : {}),
      ...(baseURL ? { baseURL } : {}),
    });
    // Clear the DOM before awaiting the daemon, including on error. Never replay after reconnect.
    form.reset();
    try {
      await request;
      setEditing(false);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Key could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const control = "h-10 w-full rounded-control bg-sunken px-3 text-body text-text shadow-ring";
  return (
    <section aria-labelledby={`${field}-title`} className="rounded-card bg-card p-5 shadow-ring">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${field}-title`} className="m-0 font-medium text-sub">
          Coordinator model
        </h2>
        {saved && (
          <Button
            onClick={() => {
              setEditing(true);
              setProblem(null);
            }}
          >
            Change key
          </Button>
        )}
      </div>
      {saved ? (
        <p role="status" className="mb-0 text-text-2">
          <span className="text-green">{provider} connected.</span>{" "}
          {credentials.storage === "os-keychain"
            ? "Key saved in your OS keychain."
            : "Key saved privately on this device."}{" "}
          Restart the daemon to apply model changes.
        </p>
      ) : (
        <form onSubmit={submit} className="mt-3 flex max-w-[560px] flex-col gap-4">
          <p id={`${field}-help`} className="m-0 text-text-2">
            Choose a provider to connect your coordinator. Your API key stays on this device.
          </p>
          <div className="flex flex-wrap gap-3">
            <label className="flex min-w-36 flex-1 flex-col gap-2" htmlFor={`${field}-provider`}>
              Provider
              {hasCatalog ? (
                <select
                  id={`${field}-provider`}
                  name="provider"
                  value={chosen?.kind ?? ""}
                  onChange={(event) => setSelected(event.currentTarget.value)}
                  className={control}
                  disabled={saving || models.length === 0}
                >
                  {models.map((entry) => (
                    <option key={entry.kind} value={entry.kind}>
                      {entry.description}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`${field}-provider`}
                  name="provider"
                  defaultValue={credentials.provider ?? ""}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  className={control}
                  disabled={saving}
                />
              )}
            </label>
            <label className="flex min-w-48 flex-[2] flex-col gap-2" htmlFor={`${field}-key`}>
              API key
              <input
                id={`${field}-key`}
                name="key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                maxLength={8192}
                pattern="[^\s]+"
                aria-describedby={`${field}-help`}
                placeholder="Paste your API key"
                className={control}
                disabled={saving}
              />
            </label>
          </div>
          {hasCatalog && models.length === 0 && (
            <p className="m-0 text-text-2">Enable a model plugin and restart the daemon to connect your coordinator.</p>
          )}
          {!hasCatalog && (
            <p className="m-0 text-text-2">
              This daemon does not list model plugins. Enter its provider kind, or update the daemon to choose from a
              list.
            </p>
          )}
          {hasCatalog && (
            <>
              <label className="flex flex-col gap-2" htmlFor={`${field}-model`}>
                Model
                <input
                  id={`${field}-model`}
                  name="model"
                  key={`${chosen?.kind}-model`}
                  required={schema?.required?.includes("model")}
                  defaultValue={savedConfig?.model ?? defaults.model?.default ?? ""}
                  placeholder="Model or deployment name"
                  className={control}
                  disabled={saving}
                />
              </label>
              <label className="flex flex-col gap-2" htmlFor={`${field}-url`}>
                Endpoint (if required by your provider)
                <input
                  id={`${field}-url`}
                  name="baseURL"
                  key={`${chosen?.kind}-baseURL`}
                  type="url"
                  required={schema?.required?.includes("baseURL")}
                  defaultValue={savedConfig?.baseURL ?? defaults.baseURL?.default ?? ""}
                  placeholder="https://api.example.com/v1"
                  className={control}
                  disabled={saving}
                />
              </label>
            </>
          )}
          {problem && (
            <p role="alert" className="m-0 text-red">
              {problem}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={saving || status !== "live" || (hasCatalog && models.length === 0)}
            >
              {saving ? "Saving…" : "Save key"}
            </Button>
            {editing && (
              <Button
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setProblem(null);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
