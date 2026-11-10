import { Skeleton } from "@/components/ui/skeleton";

/** A sandbox while it is read: its header, the conversation and the details, each where it will be. */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading sandbox" className="space-y-3 md:space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-8 w-28 max-md:hidden" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-5 w-18 rounded-full" />
        </div>
      </div>
      <div className="grid items-start gap-2 md:gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <div className="flex items-center justify-between border-b px-4 py-3 sm:px-6">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-5 w-18 rounded-full" />
          </div>
          <div className="mx-auto flex h-[min(52vh,32rem)] max-w-3xl flex-col gap-5 px-4 py-5 sm:px-6">
            <Skeleton className="h-10 w-2/5 self-end rounded-2xl" />
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-11/12" />
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3.5 w-3/5" />
            </div>
            <Skeleton className="h-9 w-full rounded-lg" />
          </div>
          <div className="border-t bg-muted/40 px-4 py-3 sm:px-6">
            <Skeleton className="h-20 w-full bg-card" />
          </div>
        </div>
        <div className="space-y-3 rounded-xl border bg-card p-5 shadow-xs max-lg:hidden">
          <Skeleton className="h-4 w-16" />
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <div key={key} className="flex justify-between gap-4">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-24" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
