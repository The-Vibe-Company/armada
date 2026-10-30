// The Settings switch for OS notifications (THE-2055): on by default, kept in
// `localStorage` on this device. The in-app toasts of a focused window are
// not behind it, and nothing makes a sound.
import { useCallback, useSyncExternalStore } from "react";

export const OS_NOTIFICATIONS_KEY = "armada.notifications.os";
const CHANGED = "armada:notifications";

/** Whether OS notifications and the badge are on: anything but a stored "off". */
export function osNotificationsOn(storage: Pick<Storage, "getItem"> | null = browserStorage()): boolean {
  try {
    return storage?.getItem(OS_NOTIFICATIONS_KEY) !== "off";
  } catch {
    return true;
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const subscribe = (change: () => void) => {
  window.addEventListener(CHANGED, change);
  window.addEventListener("storage", change);
  return () => {
    window.removeEventListener(CHANGED, change);
    window.removeEventListener("storage", change);
  };
};

/** The switch's value, followed across the app and the device's other windows, and its setter. */
export function useOsNotifications(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    subscribe,
    () => osNotificationsOn(),
    () => true,
  );
  const set = useCallback((next: boolean) => {
    try {
      browserStorage()?.setItem(OS_NOTIFICATIONS_KEY, next ? "on" : "off");
    } catch {
      // A storage the browser refuses keeps the default.
    }
    window.dispatchEvent(new Event(CHANGED));
  }, []);
  return [on, set];
}
