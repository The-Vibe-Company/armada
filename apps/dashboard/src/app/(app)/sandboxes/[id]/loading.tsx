export default function Loading() {
  return (
    <div data-fit-viewport role="status" aria-label="Loading sandbox" className="min-w-0 space-y-3">
      <span className="sr-only">Loading sandbox…</span>
      <div aria-hidden="true" className="sticky top-0 z-20 flex h-12 min-w-0 items-center gap-2 border-b bg-background">
        <div className="size-8 shrink-0 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="min-w-10 flex-1 space-y-1.5">
          <div className="h-3.5 w-40 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <div className="h-2.5 w-16 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        </div>
        <div className="h-6 w-20 shrink-0 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
        <div className="size-8 shrink-0 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      </div>
      <div
        aria-hidden="true"
        className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-3 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-5"
      >
        <div className="flex min-h-[60dvh] min-w-0 flex-col justify-between gap-4 rounded-xl border bg-[var(--surface)] p-4">
          <div className="space-y-4">
            <div className="ml-auto h-12 w-2/3 max-w-md animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" />
            <div className="space-y-2">
              <div className="h-4 w-3/4 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              <div className="h-4 w-5/6 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            </div>
          </div>
          <div className="mx-auto h-20 w-full max-w-[740px] animate-pulse rounded-2xl border bg-muted/40 motion-reduce:animate-none" />
        </div>
        <div className="hidden flex-col gap-3 rounded-xl border bg-[var(--surface)] p-2 lg:flex">
          <div className="h-8 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
          <div className="space-y-2.5 p-2">
            {[0, 1, 2, 3, 4, 5].map((key) => (
              <div key={key} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3">
                <div className="h-3.5 w-14 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                <div className="h-3.5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
