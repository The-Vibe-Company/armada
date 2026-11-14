import type { OttoMechanicalEvidence } from "@armada/core";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { ottoRequest } from "@/lib/otto-request";

export const dynamic = "force-dynamic";
export default async function EvidencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [query, viewer, selected] = await Promise.all([searchParams, requireViewer(), selectedOrganization()]);
  const repository = typeof query.repository === "string" ? query.repository : "";
  const number = typeof query.number === "string" ? query.number : "";
  let evidence: OttoMechanicalEvidence | null = null;
  const base = mcpUrl();
  if (repository && /^[1-9]\d*$/.test(number) && base && viewer.token && selected) {
    try {
      const { response, body } = await ottoRequest({
        serverUrl: base,
        token: viewer.token,
        orgId: selected.org.id,
        path: "evidence",
        params: { repository, number },
      });
      if (response.ok) evidence = body as OttoMechanicalEvidence;
    } catch {
      /* Unavailable evidence is unknown, never green. */
    }
  }
  return (
    <>
      <PageHeader title="PR evidence" description="Observed mechanical facts, not objective completion." />
      <form className="mx-auto my-6 flex max-w-md flex-col gap-3">
        <label htmlFor="repository">Repository (owner/name)</label>
        <Input id="repository" name="repository" defaultValue={repository} required />
        <label htmlFor="number">Pull request number</label>
        <Input id="number" name="number" type="number" min="1" defaultValue={number} required />
        <Button type="submit">Inspect evidence</Button>
      </form>
      {evidence ? (
        <section className="space-y-3 rounded-xl border p-5">
          <h2 className="font-semibold">
            {evidence.repository} #{evidence.number}
          </h2>
          <dl className="grid gap-2">
            <dt>Observed head SHA</dt>
            <dd className="break-all font-mono">{evidence.headSha ?? "unknown"}</dd>
            <dt>Observed at</dt>
            <dd>{evidence.observedAt ?? "unknown"}</dd>
            <dt>Required checks</dt>
            <dd>{evidence.requiredChecks}</dd>
            <dt>Mergeability (not merged)</dt>
            <dd>{evidence.mergeState}</dd>
            <dt>Merged</dt>
            <dd>
              {evidence.merged === null ? "unknown" : evidence.merged ? "observed merged" : "observed not merged"}
            </dd>
            <dt>Deployment</dt>
            <dd>Not observed — no target-environment deployment evidence is collected.</dd>
          </dl>
          <ul>
            {[...new Map(evidence.checks.map((check) => [check.name, check])).values()].map((check) => (
              <li key={check.name}>
                {check.name}: {check.state}
              </li>
            ))}
          </ul>
          <h3>Evidence links and observation times</h3>
          <ul>
            {evidence.evidence.map((e) => (
              <li key={e.factId}>
                <a href={e.url} target="_blank" rel="noreferrer" className="underline">
                  {e.kind}
                </a>{" "}
                — {e.observedAt}{" "}
                <span className="text-muted-foreground">
                  ({e.factId.startsWith("live:") ? "live observation" : e.factId})
                </span>
              </li>
            ))}
          </ul>
          <ul>
            {evidence.limits.map((limit) => (
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
