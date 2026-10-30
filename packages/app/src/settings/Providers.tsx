import type { Plugin, PluginContribution } from "@armada/protocol";
import { type FormEvent, useId, useState } from "react";
import { Dot, Field, Form, Input, Select } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { pluginCounts, pluginGroups, pluginState } from "@/plugins/list";
import { type ConfigField, configFields, configValue } from "@/plugins/schema";
import { useDaemon, useDaemonClient } from "@/protocol/store";
import { SettingsFold, SettingsRow, SettingsSection, StateDot } from "./Layout";

/**
 * Settings' Providers (THE-2069; the Plugins screen of THE-2019 before it):
 * every bundled plugin, a group per what it provides (Models, Runtimes,
 * Trackers, Forges, Nodes, Other), each a row with its state on a dot and its
 * switch, its settings folded below it (its contributions' config forms, from
 * their JSON Schemas, and its declared secrets, set or missing). Every change
 * is saved by the daemon at once and applies when it restarts: the notice
 * above the list says so, with Restart.
 */
export function Providers() {
  const { plugins, pluginsProblem, status, restarting } = useDaemon();
  const list = plugins?.plugins ?? [];
  const counts = pluginCounts(list);
  return (
    <>
      {pluginsProblem && (
        <div role="alert" className="rounded-card bg-card px-4 py-3 text-amber shadow-ring">
          {pluginsProblem}
        </div>
      )}
      {plugins && (counts.pending > 0 || restarting) && (
        <RestartNotice
          pending={counts.pending}
          restartable={plugins.restartable}
          restarting={restarting}
          live={status === "live"}
        />
      )}
      {plugins && list.length === 0 && <p className="m-0 text-text-2">This build of Armada ships no plugin.</p>}
      {pluginGroups(list).map((group) => (
        <SettingsSection key={group.seam} title={group.label} count={group.plugins.length}>
          {group.plugins.map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} live={status === "live"} />
          ))}
        </SettingsSection>
      ))}
    </>
  );
}

/** The facts line's numbers, once the daemon listed its plugins. */
export function ProvidersFacts() {
  const { plugins } = useDaemon();
  if (!plugins) return <span>Providers</span>;
  const counts = pluginCounts(plugins.plugins);
  return (
    <>
      <span>{plural(counts.total, "plugin")}</span>
      <Dot />
      <span>{counts.enabled} on</span>
      <Dot />
      <span>{counts.loaded} loaded</span>
      {counts.refused > 0 && (
        <>
          <Dot />
          <span className="text-red">{counts.refused} refused</span>
        </>
      )}
    </>
  );
}

/** The quiet line: what a switch does, or why the list is not there yet. */
export function useProvidersQuiet(): string | null {
  const { plugins, pluginsProblem, status } = useDaemon();
  if (plugins)
    return "Everything that varies in Armada is a plugin shipped with the app. A switch or a setting applies when the daemon restarts.";
  // A problem says itself above the list (or above the page, the daemon's own).
  return pluginsProblem || status === "refused" ? null : "Waiting for the daemon to list its plugins.";
}

function RestartNotice({
  pending,
  restartable,
  restarting,
  live,
}: {
  pending: number;
  restartable: boolean;
  restarting: boolean;
  live: boolean;
}) {
  const client = useDaemonClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  async function restart() {
    setAsking(true);
    setProblem(null);
    try {
      await client.restartDaemon();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The daemon could not restart.");
    } finally {
      setAsking(false);
    }
  }
  return (
    <div
      role="status"
      data-restart-notice
      className="flex flex-wrap items-center gap-3 rounded-card bg-card px-4 py-3 shadow-ring"
    >
      <span aria-hidden className="size-2 flex-none rounded-full bg-amber" />
      <span className="min-w-0 flex-1">
        {restarting ? (
          <span className="text-amber">Restarting the daemon. The list comes back when it does.</span>
        ) : (
          <>
            <span className="text-amber">Restart to apply.</span>{" "}
            <span className="text-text-2">
              {pending === 1 ? "One plugin changed" : `${pending} plugins changed`} since the daemon started.
              {!restartable && " Quit and reopen Armada to apply them."}
            </span>
          </>
        )}
        {problem && (
          <span role="alert" className="block text-red">
            {problem}
          </span>
        )}
      </span>
      {restartable && !restarting && (
        <Button variant="soft" onClick={restart} disabled={asking || !live}>
          Restart
        </Button>
      )}
    </div>
  );
}

function PluginRow({ plugin, live }: { plugin: Plugin; live: boolean }) {
  const client = useDaemonClient();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const state = pluginState(plugin);
  const configurable = plugin.contributions.some(
    (c) => c.secrets.length > 0 || configFields(c.schema, c.config).length > 0,
  );
  async function flip(enabled: boolean) {
    setSaving(true);
    setProblem(null);
    try {
      await client.setPluginEnabled(plugin.id, enabled);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The switch was not saved.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsRow
      data-plugin={plugin.id}
      title={
        <>
          <span className="truncate">{plugin.id}</span>
          {plugin.version && (
            <span className="font-mono font-normal text-heading text-text-3 tnum">{plugin.version}</span>
          )}
        </>
      }
      description={
        (plugin.description || plugin.contributions.length > 0) && (
          <span className="flex flex-col gap-1">
            {plugin.description && <span>{plugin.description}</span>}
            {plugin.contributions.length > 0 && (
              <span className="flex flex-wrap gap-1.5">
                {plugin.contributions.map((c) => (
                  <span
                    key={`${c.seam}.${c.kind}`}
                    className="rounded-xs bg-fill px-1.5 font-mono text-label text-text-2"
                  >
                    {c.seam}.{c.kind}
                  </span>
                ))}
              </span>
            )}
          </span>
        )
      }
      status={
        <>
          <StateDot {...state} title={plugin.error} />
          {plugin.error && plugin.enabled && !plugin.restartRequired && (
            <p className="m-0 pt-1 text-red">{plugin.error}</p>
          )}
          {problem && (
            <p role="alert" className="m-0 pt-1 text-red">
              {problem}
            </p>
          )}
        </>
      }
      control={
        <Switch
          aria-label={plugin.id}
          checked={plugin.enabled}
          disabled={saving || !live}
          onCheckedChange={(checked) => void flip(checked)}
        />
      }
    >
      {configurable && (
        <SettingsFold label="Settings">
          <div className="flex flex-col gap-5">
            {plugin.contributions.map((c) => (
              <Contribution key={`${c.seam}.${c.kind}`} plugin={plugin.id} contribution={c} live={live} />
            ))}
          </div>
        </SettingsFold>
      )}
    </SettingsRow>
  );
}

function Contribution({
  plugin,
  contribution: c,
  live,
}: {
  plugin: string;
  contribution: PluginContribution;
  live: boolean;
}) {
  const fields = configFields(c.schema, c.config);
  if (fields.length === 0 && c.secrets.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="m-0 flex items-baseline gap-2 font-medium text-meta">
        <span className="font-mono">
          {c.seam}.{c.kind}
        </span>
        {c.description && <span className="font-normal text-text-2">{c.description}</span>}
      </h3>
      {/* A saved config remounts the form on its new values. */}
      {fields.length > 0 && (
        <ConfigForm key={JSON.stringify(c.config)} plugin={plugin} contribution={c} fields={fields} live={live} />
      )}
      {c.secrets.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {c.secrets.map((secret) => (
            <Secret key={secret.name} plugin={plugin} name={secret.name} set={secret.set} live={live} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ConfigForm({
  plugin,
  contribution: c,
  fields,
  live,
}: {
  plugin: string;
  contribution: PluginContribution;
  fields: ConfigField[];
  live: boolean;
}) {
  const client = useDaemonClient();
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const result = configValue(fields, c.config, (name) => String(values.get(`config:${name}`) ?? ""));
    if ("problem" in result) return setProblem(result.problem);
    setSaving(true);
    setProblem(null);
    try {
      await client.configurePlugin(plugin, c.seam, c.kind, result.config);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The settings were not saved.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Form onSubmit={submit} aria-label={`${plugin} ${c.seam}.${c.kind} settings`}>
      {fields.map((f) => {
        const control = `${id}-${f.name || "config"}`;
        const common = {
          id: control,
          name: `config:${f.name}`,
          defaultValue: f.value,
          required: f.required,
          disabled: saving,
        };
        return (
          <Field
            key={f.name}
            htmlFor={control}
            label={
              <>
                {f.label}
                {!f.required && <span className="text-text-3"> (optional)</span>}
              </>
            }
            hint={f.description}
          >
            {f.kind === "choice" || f.kind === "boolean" ? (
              <Select {...common}>
                {!f.required && <option value="">Not set</option>}
                {(f.kind === "boolean" ? ["true", "false"] : (f.options ?? []).map(String)).map((option) => (
                  <option key={option} value={option}>
                    {f.kind === "boolean" ? (option === "true" ? "Yes" : "No") : option}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                {...common}
                type={f.kind === "number" || f.kind === "integer" ? "number" : "text"}
                step={f.kind === "number" ? "any" : undefined}
                spellCheck={false}
                autoComplete="off"
                className={f.kind === "json" ? "font-mono" : undefined}
              />
            )}
          </Field>
        );
      })}
      {problem && (
        <p role="alert" className="m-0 text-small text-red">
          {problem}
        </p>
      )}
      <div>
        <Button type="submit" variant="soft" disabled={saving || !live}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </Form>
  );
}

/** A declared secret: set or missing, and the owner's one way to set it (never read back). */
function Secret({ plugin, name, set, live }: { plugin: string; name: string; set: boolean; live: boolean }) {
  const client = useDaemonClient();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = String(new FormData(form).get("value") ?? "");
    // The protocol's rule (printable ASCII, no space), checked before the field is cleared.
    if (!/^[!-~]+$/.test(value)) return setProblem("Paste the value without spaces or accented characters.");
    setSaving(true);
    setProblem(null);
    const request = client.setPluginSecret(plugin, name, value);
    // As the coordinator's key: the value leaves the field before the daemon answers, and is never replayed.
    form.reset();
    try {
      await request;
      setEditing(false);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The secret was not saved.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <li data-secret={name} className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="font-mono text-small">{name}</span>
        <span className={`text-small ${set ? "text-green" : "text-amber"}`}>{set ? "Set" : "Missing"}</span>
        {!editing && (
          <Button variant="ghost" onClick={() => setEditing(true)} disabled={!live}>
            {set ? "Replace" : "Set"}
          </Button>
        )}
      </div>
      {editing && (
        <Form onSubmit={submit} aria-label={`Set ${name}`}>
          <Field htmlFor={id} label="Value" hint="Kept by the daemon on this device. It never comes back to the app.">
            <Input
              id={id}
              aria-label={name}
              name="value"
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={8192}
              disabled={saving}
            />
          </Field>
          {problem && (
            <p role="alert" className="m-0 text-small text-red">
              {problem}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" disabled={saving || !live}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </Form>
      )}
    </li>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
