import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";

export function ResourceBrowserLoading({ title, variant }: { title: string; variant: "grid" | "table" }) {
  return (
    <>
      <PageHeader title={title} />
      <div role="status" aria-label={`Loading ${title.toLowerCase()}`} className="@container min-w-0 space-y-3">
        {variant === "grid" ? (
          <>
            <Skeleton className="h-[34px] w-56 max-w-full" />
            <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
              {[0, 1, 2].map((key) => (
                <div key={key} className="rounded-xl border bg-card">
                  <div className="flex items-center gap-3 p-4">
                    <Skeleton className="size-9 shrink-0" />
                    <Skeleton className="h-4 w-32" />
                  </div>
                  <Skeleton className="mx-4 mb-4 h-3 w-32" />
                  <div className="flex h-12 items-center justify-between gap-2 border-t px-4">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-7 w-16" />
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="space-y-2 md:space-y-0 md:rounded-xl md:border md:bg-card">
            <Skeleton className="hidden h-9 rounded-b-none md:block" />
            {[0, 1, 2].map((key) => (
              <div
                key={key}
                className="grid gap-3 rounded-xl border bg-card p-3 md:h-12 md:grid-cols-4 md:items-center md:rounded-none md:border-0 md:border-t"
              >
                <Skeleton className="h-4 w-24 max-w-full" />
                <Skeleton className="h-3 w-20 max-w-full" />
                <Skeleton className="h-3 w-16 max-w-full" />
                <Skeleton className="h-3 w-24 max-w-full" />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
