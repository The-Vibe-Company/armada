// The switch for OS notifications (THE-2055), a row of Settings' Coordinator
// section (THE-2069): on by default, this device only. In a browser that has
// not been asked yet, turning it on asks; a browser that refused says so. The
// desktop shell allows them itself.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsRow, SettingsSection } from "@/settings/Layout";
import { useOsNotifications } from "./settings";

const permissionNow = (): NotificationPermission | null =>
  typeof Notification === "undefined" ? null : Notification.permission;

export function NotificationSetting() {
  const [on, setOn] = useOsNotifications();
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  useEffect(() => setPermission(permissionNow()), []);
  const ask = async () => {
    if (typeof Notification === "undefined") return;
    setPermission(await Notification.requestPermission().catch(() => Notification.permission));
  };
  return (
    <SettingsSection title="Notifications">
      <SettingsRow
        data-notifications=""
        title="OS notifications"
        description="When Armada is in the background, a coordinator's answer or a question for you shows as a silent notification and on the dock's badge. While Armada has the focus, a note shows at the bottom right instead."
        status={
          !on ? null : permission === "default" ? (
            <span className="inline-flex items-center gap-3 text-text-2">
              This browser has not allowed them for Armada yet.
              <Button onClick={() => void ask()}>Allow</Button>
            </span>
          ) : permission === "denied" ? (
            <span className="text-amber">This browser blocks them for Armada: allow them in its site settings.</span>
          ) : permission === null ? (
            <span className="text-text-3">This browser has no notifications.</span>
          ) : null
        }
        control={
          <Switch
            aria-label="OS notifications"
            checked={on}
            onCheckedChange={(checked) => {
              setOn(checked);
              if (checked && permission === "default") void ask();
            }}
          />
        }
      />
    </SettingsSection>
  );
}
