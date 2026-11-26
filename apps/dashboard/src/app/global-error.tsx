"use client";

import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh items-center justify-center bg-background p-6 font-sans text-foreground">
        <main role="alert" className="w-full max-w-md space-y-4 rounded-xl border bg-card p-6 text-card-foreground">
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold">Something went wrong</h1>
            <p className="text-sm text-muted-foreground">
              An unexpected error interrupted Armada. Try again, or reload the page.
            </p>
            {error.digest && <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={reset}
              className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              Try again
            </button>
            <a
              href="/sandboxes"
              className="inline-flex h-9 items-center justify-center rounded-md border bg-background px-4 text-sm font-medium text-foreground"
            >
              Back to sandboxes
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
