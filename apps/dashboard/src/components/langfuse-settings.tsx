"use client";

import { ActivityIcon, CircleCheckIcon, CircleDashedIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { updateLangfuse } from "@/app/actions/langfuse";
import { LangfuseDialog, LangfuseTestResult } from "@/components/langfuse-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { LangfuseAdmin, LangfuseSettings, LangfuseTest } from "@/lib/langfuse";
import { relativeAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

const FULL = "prompts, agent replies, tool inputs and results";
const METADATA = "timing, model, tokens, cost and tool names only";
const number = new Intl.NumberFormat("en");

export function LangfuseSettingsCard({ org, settings, now }: { org: string; settings: LangfuseSettings; now: number }) {
  const admin = settings.scope === "admin" ? settings : null;
  const connected = admin?.configured ?? false;
  const full = settings.contentMode === "full";
  const failed = admin?.counters.failed ?? 0;
  const dropped = admin?.counters.dropped ?? 0;
  const status = !settings.enabled
    ? {
        label: admin && !connected ? "Not connected" : "Export is off",
        icon: CircleDashedIcon,
        tone: "text-muted-foreground",
      }
    : failed > 0
      ? { label: `Exporting · ${number.format(failed)} traces refused`, icon: CircleXIcon, tone: "text-destructive" }
      : dropped > 0
        ? {
            label: `Exporting · ${number.format(dropped)} traces dropped`,
            icon: TriangleAlertIcon,
            tone: "text-warning",
          }
        : { label: "Exporting", icon: CircleCheckIcon, tone: "text-success" };
  const last = admin?.lastExportAt ? relativeAge(admin.lastExportAt, now) : null;

  return (
    <div className="overflow-hidden rounded-[10px] border bg-card">
      <div className="flex flex-col gap-4 p-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg border bg-muted text-muted-foreground">
            <ActivityIcon aria-hidden className="size-5" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", status.tone)}>
                <status.icon aria-hidden className="size-4 shrink-0" /> {status.label}
              </span>
              {(!admin || connected) && <Badge variant="secondary">{full ? "Full content" : "Metadata only"}</Badge>}
            </div>
            {connected && (
              <p className="text-xs text-muted-foreground">
                {last && admin?.lastExportAt ? (
                  <>
                    Last trace sent <time dateTime={admin.lastExportAt}>{last}</time>
                  </>
                ) : (
                  "No trace sent yet"
                )}
              </p>
            )}
            <p className="text-sm wrap-anywhere text-muted-foreground">
              {!admin ? (
                <>
                  {settings.enabled
                    ? `Agent turns in this organization's sandboxes are exported to the organization's Langfuse, with ${full ? `${FULL}, readable by everyone in that Langfuse project` : METADATA}. `
                    : "Agent turns in this organization's sandboxes are not exported to Langfuse. "}
                  Only an organization admin can change this.
                </>
              ) : !connected ? (
                "Connect a Langfuse project to see the timing, model, tokens and cost of every agent turn."
              ) : settings.enabled ? (
                <>
                  Traces go to <span className="font-mono">{admin.host}</span> with{" "}
                  {full ? `${FULL}, readable by everyone in your Langfuse project` : METADATA}.
                </>
              ) : (
                "The keys stay stored. Turn export on to resume. Turns that run while export is off are never sent."
              )}
            </p>
          </div>
        </div>
        {admin && <LangfuseControls key={String(connected)} org={org} settings={admin} />}
      </div>
      {admin && connected && <LangfuseCounters counters={admin.counters} />}
      {admin && connected && <TestStored org={org} host={admin.host} />}
    </div>
  );
}

function LangfuseControls({ org, settings }: { org: string; settings: LangfuseAdmin }) {
  const switchId = useId();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  function toggle(enabled: boolean) {
    setError("");
    start(async () => {
      try {
        const result = await updateLangfuse(org, enabled ? "enable" : "disable");
        if (!result.ok) setError(result.error);
      } catch {
        setError("Armada could not complete the request. Reload this organization before retrying.");
      }
    });
  }
  return (
    <div className="space-y-2 md:shrink-0" aria-busy={pending}>
      <div className="flex flex-wrap items-center gap-3">
        {settings.configured && (
          <label htmlFor={switchId} className="inline-flex items-center gap-2 text-sm">
            Export traces{" "}
            <Switch id={switchId} checked={settings.enabled} onCheckedChange={toggle} disabled={pending} />
          </label>
        )}
        <LangfuseDialog org={org} settings={settings} />
      </div>
      {pending && (
        <p role="status" className="text-xs text-muted-foreground">
          Saving…
        </p>
      )}
      {error && (
        <p role="alert" className="max-w-56 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function LangfuseCounters({ counters }: { counters: LangfuseAdmin["counters"] }) {
  const { exported, failed, dropped } = counters;
  return (
    <>
      <dl className="grid grid-cols-3 divide-x border-y">
        {(
          [
            ["Traces sent", exported, ""],
            ["Refused by Langfuse", failed, "text-destructive"],
            ["Dropped by Armada (overload)", dropped, "text-warning"],
          ] as const
        ).map(([label, value, tone]) => (
          <div key={label} className="flex flex-col justify-between gap-1 px-3 py-3 sm:px-4">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className={cn("text-lg font-semibold tabular-nums", value ? tone : "text-muted-foreground")}>
              {number.format(value)}
            </dd>
          </div>
        ))}
      </dl>
      {(failed > 0 || dropped > 0) && (
        <ul className="space-y-3 border-b px-4 py-3 text-sm">
          {failed > 0 && (
            <li className="flex items-start gap-2">
              <CircleXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div>
                <strong>{number.format(failed)} traces refused by Langfuse</strong>
                <p className="text-muted-foreground">
                  Langfuse refused {number.format(failed)} traces; they are not sent again. Test the connection to see
                  whether this is still happening. If the test fails, open Edit and replace the keys.
                </p>
              </div>
            </li>
          )}
          {dropped > 0 && (
            <li className="flex items-start gap-2">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              <div>
                <strong>{number.format(dropped)} traces dropped by Armada</strong>
                <p className="text-muted-foreground">
                  Armada had too much to send at once. Nothing to do unless this keeps rising; then contact whoever runs
                  your Armada server.
                </p>
              </div>
            </li>
          )}
        </ul>
      )}
    </>
  );
}

function TestStored({ org, host }: { org: string; host: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<LangfuseTest>();
  const [error, setError] = useState("");
  function test() {
    setResult(undefined);
    setError("");
    start(async () => {
      try {
        const response = await updateLangfuse(org, "test-stored");
        if (response.ok) setResult(response.test);
        else setError(response.error);
      } catch {
        setError("Armada could not complete the request. Reload this organization before retrying.");
      }
    });
  }
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-end">
      {result && <LangfuseTestResult result={result} host={new URL(host).host} />}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="button" variant="outline" size="sm" onClick={test} disabled={pending}>
        {pending ? "Testing…" : "Test the connection"}
      </Button>
    </div>
  );
}
