import { sandboxRowGrid } from "@/components/sandbox-list-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function LoadingSandboxes() {
  return (
    <div aria-label="Loading sandboxes" role="status" className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-9 w-40" />
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        <Skeleton className="h-9 w-full sm:max-w-[440px]" />
        <Skeleton className="h-9 w-full sm:max-w-[380px]" />
      </div>
      <div className="divide-y overflow-hidden rounded-[10px] border bg-card">
        <div className="hidden h-9 bg-muted/40 md:block" />
        {["first", "second", "third", "fourth", "fifth"].map((row) => (
          <div key={row} className={cn(sandboxRowGrid, "grid h-[144px] gap-y-2 py-2.5 md:h-12 md:py-0")}>
            <Skeleton className="col-span-2 h-7 w-3/4 md:col-span-1" />
            <Skeleton className="col-start-1 row-start-2 h-5 w-3/4 md:col-start-2 md:row-start-1" />
            <Skeleton className="col-start-1 row-start-3 h-7 w-3/4 md:col-start-3 md:row-start-1" />
            <Skeleton className="col-start-2 row-start-3 h-7 w-3/4 md:col-start-4 md:row-start-1" />
            <Skeleton className="col-start-2 row-start-2 h-7 w-3/4 md:col-start-5 md:row-start-1 md:justify-self-end" />
            <div className="col-start-3 row-start-1 flex w-[72px] justify-end md:col-start-6">
              <Skeleton className="size-7" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
