import { Skeleton } from "@/components/ui/skeleton";

export default function LoadingSandboxes() {
  return (
    <div aria-label="Loading sandboxes" role="status" className="space-y-[18px]">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-[34px] w-36" />
        <Skeleton className="h-[34px] w-40" />
      </div>
      <div className="flex flex-wrap justify-between gap-3">
        <Skeleton className="h-9 w-full sm:w-[520px]" />
        <Skeleton className="h-[34px] w-full sm:w-[280px]" />
      </div>
      <div className="overflow-hidden rounded-[10px] border bg-card">
        <div className="hidden h-9 bg-muted/40 lg:block" />
        {["first", "second", "third", "fourth", "fifth"].map((row) => (
          <div key={row} className="grid gap-4 border-t px-4 py-[11px] lg:grid-cols-[2.8fr_1.3fr_.8fr_1fr_.9fr_64px]">
            <div className="space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="h-8 w-24" />
            <Skeleton className="hidden h-8 w-20 lg:block" />
            <Skeleton className="hidden h-5 w-20 lg:block" />
            <Skeleton className="hidden h-5 w-16 lg:block" />
            <Skeleton className="hidden h-5 w-10 lg:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
