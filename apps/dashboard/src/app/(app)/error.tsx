"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section role="alert" className="space-y-4 rounded-xl border bg-background p-6 text-foreground">
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          An unexpected error interrupted this page. Try again, or return to your sandboxes.
        </p>
        {error.digest && <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={reset}>
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link href="/sandboxes">Back to sandboxes</Link>
        </Button>
      </div>
    </section>
  );
}
