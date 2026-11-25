import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { HARNESS_ORDER } from "@/lib/model-accounts";

export default function Loading() {
  return (
    <>
      <PageHeader title="Models" inlineActions>
        <Skeleton className="h-8 w-36" />
      </PageHeader>
      <div role="status" aria-label="Loading model accounts" className="space-y-[18px]">
        <div className="flex flex-wrap gap-x-6 gap-y-3 rounded-[10px] border bg-card px-4 py-3">
          {HARNESS_ORDER.map((key) => (
            <div key={key} className="space-y-0.5">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-8 w-28 rounded-[6px]" />
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <div className="flex flex-wrap justify-between gap-3">
            <Skeleton className="h-[34px] w-56" />
            <Skeleton className="h-[34px] w-[260px] max-w-full" />
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,310px),1fr))] gap-3">
            {[0, 1, 2].map((key) => (
              <div key={key} className="rounded-[10px] border bg-card">
                <div className="flex items-start gap-3 px-4 pt-4">
                  <Skeleton className="size-9" />
                  <div className="flex-1 space-y-1">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                  <Skeleton className="h-5 w-14 rounded-full" />
                </div>
                <div className="space-y-1.5 px-4 py-3">
                  <div className="flex justify-between">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-10" />
                  </div>
                  <Skeleton className="h-1 w-full" />
                </div>
                <div className="flex min-h-11 items-center justify-between border-t px-4 py-2">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-12" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
