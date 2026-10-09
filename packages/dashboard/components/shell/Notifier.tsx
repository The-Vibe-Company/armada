"use client";

// Browser notifications for what needs the owner (THE-894), while a tab of
// the dashboard is open: each poll's owner items (lib/notify.ts), shown once
// each per browser (the keys already seen are kept in localStorage, and a
// notification's tag stops two tabs from showing it twice), when the viewer
// turned them on, allowed them and is outside their quiet hours. Items that
// were already there, or came while notifications were off or quiet, are
// only marked seen. A click opens the item. The live region (Announcer) says
// the same in the page.
import { ownerItems } from "@armada/core/read";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { notificationsSupported, notificationTitle, toNotify } from "@/lib/notify";
import { useFleet, useShell } from "./context";
import { useVisit } from "./visit";

const SEEN_KEY = "armada-notified";
const SEEN_MAX = 300;

function readSeen(): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    return raw === null ? null : new Set(JSON.parse(raw) as string[]);
  } catch {
    return null;
  }
}

function writeSeen(keys: Iterable<string>) {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...keys].slice(-SEEN_MAX)));
  } catch {
    // Private mode: nothing is kept, nothing is repeated within this page either way.
  }
}

export function Notifier() {
  const { overview } = useFleet();
  const { t } = useShell();
  const settings = useVisit()?.answer?.notify ?? null;
  const router = useRouter();

  useEffect(() => {
    if (!settings) return;
    const items = ownerItems(overview);
    const seen = readSeen();
    const allowed = notificationsSupported() && Notification.permission === "granted";
    const fresh = seen && allowed ? toNotify(items, seen, settings, new Date()) : [];
    writeSeen(new Set([...(seen ?? []), ...items.map((i) => i.key)]));
    for (const item of fresh) {
      try {
        const n = new Notification(notificationTitle(t, item), { body: t.notify.open, tag: item.key });
        n.onclick = () => {
          window.focus();
          router.push(item.href);
          n.close();
        };
      } catch {
        // A browser that notifies through a service worker only (Chrome on Android): the page keeps the item.
        return;
      }
    }
  }, [overview, settings, t, router]);

  return null;
}
