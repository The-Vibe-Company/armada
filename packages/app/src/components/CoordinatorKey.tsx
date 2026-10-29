import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { useDaemon, useDaemonClient } from "@/protocol/store";

/** A key lives only in the password field until one explicit submit. Never in app state/storage. */
export function CoordinatorKey() {
  const { credentials, status } = useDaemon();
  const client = useDaemonClient();
  const field = useId();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!credentials) return null;
  const provider = credentials.provider === "openai" ? "OpenAI" : "Anthropic";
  const saved = credentials.provider !== null && !editing;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setSaving(true);
    setProblem(null);
    const request = client.saveCredentials(values.get("provider") as "anthropic" | "openai", String(values.get("key")));
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
            : "Key saved privately on this device."}
        </p>
      ) : (
        <form onSubmit={submit} className="mt-3 flex max-w-[560px] flex-col gap-4">
          <p id={`${field}-help`} className="m-0 text-text-2">
            Choose a provider to connect your coordinator. Your API key stays on this device.
          </p>
          <div className="flex flex-wrap gap-3">
            <label className="flex min-w-36 flex-1 flex-col gap-2" htmlFor={`${field}-provider`}>
              Provider
              <select
                id={`${field}-provider`}
                name="provider"
                defaultValue={credentials.provider ?? "anthropic"}
                className={control}
                disabled={saving}
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
              </select>
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
          {problem && (
            <p role="alert" className="m-0 text-red">
              {problem}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" disabled={saving || status !== "live"}>
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
