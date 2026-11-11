import { PageHeader } from "@/components/page-header";

export default function Loading() {
  return (
    <>
      <PageHeader
        title="Skills"
        description="The Skillpack key that installs your private skills in the sandboxes Armada launches."
      />
      <div role="status" aria-label="Loading the Skillpack key" className="divide-y rounded-xl border">
        {[0, 1].map((key) => (
          <div key={key} className="flex items-center gap-3 p-4">
            <div className="size-8 animate-pulse rounded-md bg-muted" />
            <div className="h-4 w-40 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </>
  );
}
