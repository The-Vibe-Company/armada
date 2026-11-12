import { PageHeader } from "@/components/page-header";

/** Shown while accounts and their usage are read (each usage read is bounded by the server's own budget). */
export default function Loading() {
  return (
    <>
      <PageHeader title="Models" />
      <div role="status" aria-label="Loading subscriptions" className="space-y-3">
        {[0, 1].map((key) => (
          <div key={key} className="space-y-3 rounded-lg border p-4">
            <div className="h-4 w-40 animate-pulse rounded bg-muted" />
            <div className="h-3 w-72 max-w-full animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </>
  );
}
