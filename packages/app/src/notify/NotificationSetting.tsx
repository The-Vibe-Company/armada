// The Settings switch for OS notifications (THE-2055): on by default, this
// device only. In a browser that has not been asked yet, turning it on asks;
// a browser that refused says so. The desktop shell allows them itself.
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useOsNotifications } from "./settings";

const permissionNow = (): NotificationPermission | null =>
  typeof Notification === "undefined" ? null : Notification.permission;

export function NotificationSetting() {
  const field = useId();
  const [on, setOn] = useOsNotifications();
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  useEffect(() => setPermission(permissionNow()), []);
  const ask = async () => {
    if (typeof Notification === "undefined") return;
    setPermission(await Notification.requestPermission().catch(() => Notification.permission));
  };
  return (
    <section aria-labelledby={`${field}-title`} className="rounded-card bg-card p-5 shadow-ring" data-notifications>
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${field}-title`} className="m-0 font-medium text-sub">
          Notifications
        </h2>
        <Switch
          aria-label="OS notifications"
          aria-describedby={`${field}-help`}
          checked={on}
          onCheckedChange={(checked) => {
            setOn(checked);
            if (checked && permission === "default") void ask();
          }}
        />
      </div>
      <p id={`${field}-help`} className="mb-0 text-text-2">
        When Armada is in the background, a coordinator's answer or a question for you shows as a silent notification
        and on the dock's badge. While Armada has the focus, a note shows at the bottom right instead.
      </p>
      {on && permission === "default" && (
        <div className="mt-3 flex items-center gap-3">
          <p className="m-0 text-text-2">This browser has not allowed notifications for Armada yet.</p>
          <Button onClick={() => void ask()}>Allow</Button>
        </div>
      )}
      {on && permission === "denied" && (
        <p className="mb-0 text-amber">
          This browser blocks notifications for Armada: allow them in its site settings.
        </p>
      )}
      {permission === null && <p className="mb-0 text-text-3">This browser has no notifications.</p>}
    </section>
  );
}
