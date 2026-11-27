"use client";

import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

type SyncBody = { ok?: boolean; status?: string; installations?: unknown[]; error?: string } | null;

export function GitHubSyncButton({ label = "Sync organizations" }: { label?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleSync() {
    if (pending) return;
    setPending(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/github/sync", { method: "POST", cache: "no-store" });
      const data = (await res.json().catch(() => null)) as SyncBody;
      if (!res.ok || !data?.ok) {
        setFeedback({ ok: false, text: data?.error ?? "Could not sync GitHub organizations." });
        return;
      }
      const n = Array.isArray(data.installations) ? data.installations.length : 0;
      const msg =
        data.status === "connected"
          ? `Synced ${n} ${n === 1 ? "installation" : "installations"}.`
          : "Status refreshed.";
      setFeedback({ ok: true, text: msg });
      router.refresh();
    } catch {
      setFeedback({ ok: false, text: "Could not reach Armada to sync GitHub organizations." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={pending} aria-busy={pending} onClick={handleSync}>
        <RefreshCwIcon aria-hidden="true" className={pending ? "size-3.5 motion-safe:animate-spin" : "size-3.5"} />
        {pending ? "Syncing…" : label}
      </Button>
      <span
        role={feedback && !feedback.ok ? "alert" : "status"}
        aria-live="polite"
        className={feedback ? (feedback.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive") : "sr-only"}
      >
        {feedback?.text ?? ""}
      </span>
    </div>
  );
}
