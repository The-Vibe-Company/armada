import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeader title="Models" />
      <div role="status" aria-label="Loading model accounts" className="space-y-8">
        <div className="rounded-lg border px-5 py-2">
          <Skeleton className="my-3 h-4 w-32" />
          {[0, 1, 2].map((key) => (
            <div key={key} className="border-b py-4 last:border-0">
              <Skeleton className="h-7 w-3/4" />
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <Skeleton className="h-6 w-24" />
          <div className="rounded-lg border">
            {[0, 1, 2].map((key) => (
              <div key={key} className="border-b p-4 last:border-0">
                <Skeleton className="h-28 w-full sm:h-40" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
