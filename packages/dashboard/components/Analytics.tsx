"use client";

// PostHog in the browser (lib/analytics.ts decides whether and where). The
// SDK loads apart from every page once the browser is idle, so it adds nothing
// to first-load JS (THE-892), then counts each page view, the first and each
// move inside the app, and autocaptures as PostHog does by default. What a
// page asks before it loaded (who is signed in, a sign-out) waits for it.
import type { CaptureResult, PostHog } from "posthog-js";
import { useEffect } from "react";
import { POSTHOG_UI_HOST, type Analytics as Settings, withoutOneTimeCodes } from "@/lib/analytics";

let loaded: PostHog | null = null;
const waiting: ((posthog: PostHog) => void)[] = [];

/** Runs `use` once PostHog is loaded; never when this deployment does not report. */
export function withPostHog(use: (posthog: PostHog) => void): void {
  if (loaded) use(loaded);
  else waiting.push(use);
}

/** An event with the one-time codes of its addresses masked (`/device?user_code=`). */
function masked(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  const clean = (props: Record<string, unknown> | undefined) =>
    props && Object.fromEntries(Object.entries(props).map(([k, v]) => [k, withoutOneTimeCodes(v)]));
  return {
    ...event,
    properties: clean(event.properties) ?? {},
    $set: clean(event.$set),
    $set_once: clean(event.$set_once),
  };
}

/** Starts `posthog` with `settings`, then runs what waited for it, in order. */
export function startPostHog(posthog: PostHog, settings: Settings): void {
  if (loaded) return;
  posthog.init(settings.key, {
    api_host: settings.host,
    ui_host: POSTHOG_UI_HOST,
    defaults: "2026-08-30",
    // The App Router moves without a page load: each history change is a page view.
    capture_pageview: "history_change",
    before_send: masked,
  });
  loaded = posthog;
  for (const use of waiting.splice(0)) use(posthog);
}

/** Loads and starts PostHog when `settings` say this deployment reports. In the root layout. */
export function Analytics({ settings }: { settings: Settings | null }) {
  useEffect(() => {
    if (!settings || loaded) return;
    let live = true;
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const id = idle(
      () =>
        void import("posthog-js")
          .then(({ default: posthog }) => live && startPostHog(posthog, settings))
          // A blocker or a lost chunk only means no analytics: never an error on the page.
          .catch(() => {}),
    );
    return () => {
      live = false;
      cancel(id);
    };
  }, [settings]);
  return null;
}

/** Ties this browser's events to the signed-in person, on sign-in and on each return with a session. */
export function AnalyticsViewer({ id, email, name }: { id: string; email: string; name: string }) {
  useEffect(() => withPostHog((posthog) => posthog.identify(id, { email, name })), [id, email, name]);
  return null;
}
