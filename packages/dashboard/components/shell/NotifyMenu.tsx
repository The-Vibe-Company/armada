"use client";

// The account menu's notification settings (THE-894): turn browser
// notifications on (the browser asks for its permission on that click), and
// the quiet hours, in the viewer's own time. Kept per person by Armada.
import { useState } from "react";
import { NOTIFY_OFF, notificationsSupported } from "@/lib/notify";
import { useShell } from "./context";
import { useVisit } from "./visit";

const DEFAULT_QUIET = { from: "22:00", to: "08:00" };

export function NotifyMenu() {
  const { t } = useShell();
  const visit = useVisit();
  const supported = notificationsSupported();
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    supported ? Notification.permission : "denied",
  );
  if (!visit) return null;
  const settings = visit.answer?.notify ?? NOTIFY_OFF;
  const toggle = async () => {
    if (!settings.on && supported && Notification.permission !== "granted") {
      const answer = await Notification.requestPermission();
      setPermission(answer);
      if (answer !== "granted") return;
    }
    visit.setNotify({ ...settings, on: !settings.on });
  };
  const setQuiet = (quiet: typeof settings.quiet) => visit.setNotify({ ...settings, quiet });
  return (
    <>
      <div className="sh-menu-sep" />
      <div className="sh-menu-h">{t.notify.title}</div>
      <div className="sh-menu-row">
        <span id="sh-notify-label">{t.notify.on}</span>
        <span className="spacer" />
        <button
          type="button"
          role="switch"
          className="sh-switch"
          aria-checked={settings.on}
          aria-labelledby="sh-notify-label"
          aria-describedby="sh-notify-hint"
          disabled={!supported}
          onClick={() => void toggle()}
        />
      </div>
      <p className="sh-menu-note" id="sh-notify-hint">
        {!supported ? t.notify.unsupported : permission === "denied" ? t.notify.denied : t.notify.hint}
      </p>
      {settings.on && (
        <div className="sh-menu-row sh-quiet">
          <label className="sh-quiet-toggle">
            <input
              type="checkbox"
              checked={settings.quiet !== null}
              onChange={(e) => setQuiet(e.target.checked ? DEFAULT_QUIET : null)}
            />
            {t.notify.quiet}
          </label>
          {settings.quiet && (
            <span className="sh-quiet-times">
              <input
                type="time"
                aria-label={`${t.notify.quiet} · ${t.notify.from}`}
                value={settings.quiet.from}
                onChange={(e) => {
                  const from = e.target.value;
                  if (settings.quiet && from && from !== settings.quiet.to) setQuiet({ ...settings.quiet, from });
                }}
              />
              <span aria-hidden>–</span>
              <input
                type="time"
                aria-label={`${t.notify.quiet} · ${t.notify.to}`}
                value={settings.quiet.to}
                onChange={(e) => {
                  const to = e.target.value;
                  if (settings.quiet && to && to !== settings.quiet.from) setQuiet({ ...settings.quiet, to });
                }}
              />
            </span>
          )}
        </div>
      )}
    </>
  );
}
