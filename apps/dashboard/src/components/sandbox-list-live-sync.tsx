"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { LIVE_FLEET_CHANGE_EVENT } from "@/lib/live-sandbox-view";

export function SandboxListLiveSync({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  useEffect(() => {
    function onChange(event: Event) {
      const detail = (event as CustomEvent<{ organizationId?: string }>).detail;
      if (detail?.organizationId && detail.organizationId !== organizationId) return;
      startTransition(() => router.refresh());
    }
    window.addEventListener(LIVE_FLEET_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(LIVE_FLEET_CHANGE_EVENT, onChange);
  }, [organizationId, router]);
  return null;
}
