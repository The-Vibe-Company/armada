"use client";

import type { ReactNode } from "react";
import { signOut } from "@/app/auth-actions";
import { withPostHog } from "./Analytics";

/** The accounts' sign-out form: it forgets the person in this browser's analytics before the session ends. */
export function SignOutForm({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <form action={signOut} className={className} onSubmit={() => withPostHog((posthog) => posthog.reset())}>
      {children}
    </form>
  );
}
