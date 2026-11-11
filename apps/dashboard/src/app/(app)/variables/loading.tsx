import { PageHeader } from "@/components/page-header";

export default function Loading() {
  return (
    <>
      <PageHeader title="Variables" description="Configuration and write-only secrets for your agents." />
      <div role="status" aria-label="Loading variables" className="space-y-3">
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
