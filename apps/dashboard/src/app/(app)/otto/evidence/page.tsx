import type { OttoMechanicalProof } from "@armada/core";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";

export const dynamic = "force-dynamic";
export default async function EvidencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [query, viewer, selected] = await Promise.all([searchParams, requireViewer(), selectedOrganization()]);
  const repository = typeof query.repository === "string" ? query.repository : "";
  const number = typeof query.number === "string" ? query.number : "";
  let proof: OttoMechanicalProof | null = null;
  const base = mcpUrl();
  if (repository && /^[1-9]\d*$/.test(number) && base && viewer.token && selected) {
    const url = new URL("/api/v1/otto/evidence", base);
    url.searchParams.set("repository", repository);
    url.searchParams.set("number", number);
    url.searchParams.set("org_id", selected.org.id);
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${viewer.token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) proof = await response.json();
    } catch {
      /* Unavailable evidence is unknown, never green. */
    }
  }
  return (
    <>
      <PageHeader title="PR evidence" description="Observed mechanical facts, not objective completion." />
      <Link href="/otto" className="underline">
        Back to Otto
      </Link>
      <form className="mx-auto my-6 flex max-w-md flex-col gap-3">
        <label htmlFor="repository">Repository (owner/name)</label>
        <Input id="repository" name="repository" defaultValue={repository} required />
        <label htmlFor="number">Pull request number</label>
        <Input id="number" name="number" type="number" min="1" defaultValue={number} required />
        <Button type="submit">Inspect evidence</Button>
      </form>
      {proof ? (
        <section className="space-y-3 rounded-xl border p-5">
          <h2 className="font-semibold">
            {proof.repository} #{proof.number}
          </h2>
          <dl className="grid gap-2">
            <dt>Observed head SHA</dt>
            <dd className="break-all font-mono">{proof.headSha ?? "unknown"}</dd>
            <dt>Observed at</dt>
            <dd>{proof.observedAt ?? "unknown"}</dd>
            <dt>Required checks</dt>
            <dd>{proof.requiredChecks}</dd>
            <dt>Mergeability (not merged)</dt>
            <dd>{proof.mergeState}</dd>
            <dt>Merged</dt>
            <dd>{proof.merged === null ? "unknown" : proof.merged ? "observed merged" : "observed not merged"}</dd>
            <dt>Deployment</dt>
            <dd>{proof.deployment}</dd>
          </dl>
          <ul>
            {[...new Map(proof.checks.map((check) => [check.name, check])).values()].map((check) => (
              <li key={check.name}>
                {check.name}: {check.state}
              </li>
            ))}
          </ul>
          <h3>Evidence links and observation times</h3>
          <ul>
            {proof.evidence.map((e) => (
              <li key={e.factId}>
                <a href={e.url} target="_blank" rel="noreferrer" className="underline">
                  {e.kind}
                </a>{" "}
                — {e.observedAt} <span className="text-muted-foreground">({e.factId})</span>
              </li>
            ))}
          </ul>
          <ul>
            {proof.limits.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="my-6">
          Evidence unknown. Select a connected repository and PR. Missing access or incomplete observations never mean
          done or green.
        </p>
      )}
    </>
  );
}
