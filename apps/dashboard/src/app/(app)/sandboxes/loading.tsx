import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";

/** The list's own shape while it is read: the toolbar and a few rows, so nothing moves when it arrives. */
export default function Loading() {
  return (
    <>
      <PageHeader title="Sandboxes">
        <Skeleton className="h-9 w-40" />
      </PageHeader>
      <div role="status" aria-label="Loading sandboxes" className="space-y-6">
        <div className="grid grid-cols-2 gap-2 sm:flex">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-9 sm:w-44" />
          ))}
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <div className="h-9 border-b bg-muted/50" />
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className="flex items-center gap-6 border-b px-3 py-3.5 last:border-0">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-5 w-18 rounded-full" />
              <Skeleton className="hidden h-4 w-16 sm:block" />
              <Skeleton className="hidden h-4 w-24 md:block" />
              <Skeleton className="ml-auto hidden h-4 w-20 lg:block" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
