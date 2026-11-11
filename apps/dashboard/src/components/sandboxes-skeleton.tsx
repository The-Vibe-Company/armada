import { Skeleton } from "@/components/ui/skeleton";

export default function LoadingSandboxes() {
  return (
    <div aria-label="Loading sandboxes" role="status" className="space-y-6">
      <Skeleton className="h-9 w-48" />
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-9 w-24" />
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="rounded-xl border p-4">
        {["first", "second", "third", "fourth", "fifth"].map((row) => (
          <div key={row} className="flex flex-wrap gap-4 border-b py-5 last:border-0">
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}
