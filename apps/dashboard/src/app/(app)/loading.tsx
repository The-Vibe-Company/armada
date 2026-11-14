/** Shared navigation boundary for sections without a more specific loading view.
 * Keeps the signed-in shell interactive while the destination reads user-scoped data.
 */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading page" className="space-y-6">
      <span className="sr-only">Loading page…</span>
      <div aria-hidden="true" className="space-y-3">
        <div className="h-7 w-40 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        <div className="h-4 w-72 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
      </div>
      <div aria-hidden="true" className="space-y-4 rounded-lg border p-4">
        {[0, 1, 2].map((key) => (
          <div key={key} className="h-10 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}
