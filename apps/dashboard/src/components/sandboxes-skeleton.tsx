import { sandboxRowGrid } from "@/components/sandbox-list-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function LoadingSandboxes() {
  return (
    <div aria-label="Loading sandboxes" role="status" className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-36" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-full sm:max-w-[360px]" />
        <Skeleton className="h-9 w-full sm:ml-auto sm:max-w-[380px]" />
      </div>
      <div className="divide-y rounded-xl border bg-card shadow-xs">
        <div className="hidden h-9 rounded-t-xl bg-[var(--sunken)] md:block" />
        {["first", "second", "third", "fourth", "fifth"].map((row) => (
          <div
            key={row}
            className={cn(sandboxRowGrid, "grid min-h-[124px] gap-y-2 py-2.5 md:h-[58px] md:min-h-[58px]")}
          >
            <div className="col-span-2 space-y-1.5 md:col-span-1">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="col-start-1 row-start-2 h-4 w-24 md:col-start-2 md:row-start-1" />
            <div className="col-start-1 row-start-3 space-y-1.5 md:col-start-3 md:row-start-1">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3 w-20" />
            </div>
            <div className="col-start-2 col-span-2 row-start-3 space-y-1.5 md:col-start-4 md:col-span-1 md:row-start-1">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-20" />
            </div>
            <div className="col-start-2 col-span-2 row-start-2 flex flex-col items-end space-y-1.5 md:col-start-5 md:col-span-1 md:row-start-1">
              <Skeleton className="h-3.5 w-12" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="col-start-3 row-start-1 flex w-9 justify-end md:col-start-6">
              <Skeleton className="size-8 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
