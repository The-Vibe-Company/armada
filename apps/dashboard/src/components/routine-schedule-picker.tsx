"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { previewRoutineSchedule } from "@/app/actions/routines";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  presetToCron,
  type RoutinePreset,
  type RoutineScheduleChoice,
  type RoutineSchedulePreview,
} from "@/lib/routine-schedule";

const DAYS = [
  [1, "Monday"],
  [2, "Tuesday"],
  [3, "Wednesday"],
  [4, "Thursday"],
  [5, "Friday"],
  [6, "Saturday"],
  [0, "Sunday"],
] as const;
const FALLBACK_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Europe/London",
  "Europe/Paris",
];
type PreviewState = {
  key: string;
  result: { ok: true; preview: RoutineSchedulePreview } | { ok: false; error: string };
};

export function RoutineSchedulePicker({
  orgId,
  onValidated,
}: {
  orgId: string;
  onValidated: (key: string | null) => void;
}) {
  const base = useId();
  const [choice, setChoice] = useState<RoutineScheduleChoice>({
    preset: "daily",
    time: "09:00",
    weekdays: [1],
    dayOfMonth: "1",
    custom: "0 9 * * *",
  });
  const [timezone, setTimezone] = useState("UTC"),
    [zones, setZones] = useState(FALLBACK_ZONES),
    [preview, setPreview] = useState<PreviewState | null>(null),
    [retry, setRetry] = useState(0);
  const parsed = presetToCron(choice),
    cron = parsed.ok ? parsed.cron : "";
  const key = JSON.stringify([cron, timezone]);
  const current = preview?.key === key ? preview.result : null;
  useEffect(() => {
    // Start with identical server/client markup, then use the browser's supported
    // IANA list. UTC remains explicit even when ICU does not include it in the list.
    try {
      setZones(["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")]);
    } catch {
      /* Older browsers retain the useful fallback list. */
    }
  }, []);
  const request = useMemo(() => ({ orgId, cron, timezone, key, retry }), [orgId, cron, timezone, key, retry]);
  useEffect(() => {
    let active = true;
    onValidated(null);
    setPreview(null);
    if (!request.cron) return;
    const timer = window.setTimeout(() => {
      void previewRoutineSchedule(request.orgId, request.cron, request.timezone)
        .then((result) => {
          if (!active) return;
          setPreview({ key: request.key, result });
          onValidated(result.ok ? request.key : null);
        })
        .catch(() => {
          if (active)
            setPreview({
              key: request.key,
              result: { ok: false, error: "Schedule preview is unavailable. Try again." },
            });
        });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [request, onValidated]);
  const change = (patch: Partial<RoutineScheduleChoice>) => {
    onValidated(null);
    setChoice((previous) => ({ ...previous, ...patch }));
  };
  const formatter = current?.ok
    ? new Intl.DateTimeFormat("en", {
        timeZone: current.preview.timezone,
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZoneName: "longOffset",
      })
    : null;
  return (
    <section className="space-y-3" aria-label="Routine schedule">
      <input type="hidden" name="cron" value={cron} />
      <input type="hidden" name="timezone" value={timezone} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${base}-preset`}>Schedule</Label>
          <NativeSelect
            id={`${base}-preset`}
            value={choice.preset}
            onChange={(event) => {
              const preset = event.target.value as RoutinePreset;
              change({ preset, ...(preset === "custom" && parsed.ok ? { custom: parsed.cron } : {}) });
            }}
          >
            <option value="hourly">Every hour</option>
            <option value="daily">Every day at</option>
            <option value="weekdays">Weekdays at</option>
            <option value="weekly">Weekly on days at</option>
            <option value="monthly">Monthly on day at</option>
            <option value="custom">Custom cron</option>
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${base}-zone`}>Time zone</Label>
          <NativeSelect
            id={`${base}-zone`}
            value={timezone}
            onChange={(event) => {
              onValidated(null);
              setTimezone(event.target.value);
            }}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll("_", " ")}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {choice.preset !== "hourly" && choice.preset !== "custom" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${base}-time`}>Time</Label>
            <Input
              id={`${base}-time`}
              type="time"
              required
              step={60}
              value={choice.time}
              onChange={(event) => change({ time: event.target.value })}
            />
          </div>
          {choice.preset === "monthly" && (
            <div className="space-y-1.5">
              <Label htmlFor={`${base}-day`}>Day of month</Label>
              <Input
                id={`${base}-day`}
                type="number"
                min={1}
                max={31}
                step={1}
                required
                value={choice.dayOfMonth}
                onChange={(event) => change({ dayOfMonth: event.target.value })}
              />
            </div>
          )}
        </div>
      )}
      {choice.preset === "weekly" && (
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium">Days</legend>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
            {DAYS.map(([day, name]) => (
              <Label
                key={day}
                htmlFor={`${base}-day-${day}`}
                className="flex min-h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-1 text-xs"
              >
                <Checkbox
                  id={`${base}-day-${day}`}
                  aria-label={name}
                  checked={choice.weekdays.includes(day)}
                  onCheckedChange={(checked) =>
                    change({
                      weekdays: checked
                        ? [...choice.weekdays, day]
                        : choice.weekdays.filter((selected) => selected !== day),
                    })
                  }
                />
                {name.slice(0, 3)}
              </Label>
            ))}
          </div>
        </fieldset>
      )}
      {choice.preset === "monthly" && (
        <p className="text-xs text-muted-foreground">Months without this day are skipped.</p>
      )}
      {choice.preset === "custom" && (
        <div className="space-y-1.5">
          <Label htmlFor={`${base}-cron`}>Cron expression</Label>
          <Input
            id={`${base}-cron`}
            required
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            placeholder="0 9 * * MON-FRI"
            value={choice.custom}
            onChange={(event) => change({ custom: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">Minute, hour, day of month, month, day of week.</p>
        </div>
      )}
      <section
        className="rounded-md bg-muted/50 px-3 py-2.5"
        aria-label="Schedule preview"
        aria-live="polite"
        aria-atomic="true"
      >
        {!parsed.ok ? (
          <p className="text-sm text-destructive">{parsed.error}</p>
        ) : !current ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checking schedule…
          </p>
        ) : !current.ok ? (
          <div className="space-y-1.5">
            <p role="alert" className="text-sm text-destructive">
              {current.error}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onValidated(null);
                setRetry((value) => value + 1);
              }}
            >
              Try preview again
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">{current.preview.description}</p>
            <div>
              <h3 className="mb-1 text-xs text-muted-foreground">Upcoming times</h3>
              <ol className="space-y-0.5 text-xs tabular-nums">
                {current.preview.nextRuns.map((date) => (
                  <li key={date}>
                    <time dateTime={date}>{formatter?.format(new Date(date))}</time>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </section>
      <p className="text-xs text-muted-foreground">
        At least one hour between runs. Upcoming times are calendar matches, not guaranteed launches.
      </p>
    </section>
  );
}
