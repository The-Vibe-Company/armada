import type { OttoTicketGraph } from "@armada/core";
import { ticketStates } from "@armada/core";
import { objectiveRequest } from "@/lib/data/otto-objectives";

export async function TicketGraphPanel({ orgId, id }: { orgId: string; id: string }) {
  let graph: OttoTicketGraph | null;
  try {
    ({ graph } = await objectiveRequest<{ graph: OttoTicketGraph | null }>(orgId, `/${id}/tickets`));
  } catch {
    return (
      <section>
        <h2>Tickets</h2>
        <p>Ticket graph unavailable. No readiness inferred.</p>
      </section>
    );
  }
  return (
    <section aria-label="Ticket dependency graph" className="space-y-4">
      <h2 className="font-medium">Tickets</h2>
      {!graph ? (
        <p>No ticket plan published yet.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Brief revision {graph.briefRevision}. Planning does not create GitHub issues.
          </p>
          <ol className="space-y-4">
            {ticketStates(graph).map((t) => (
              <li key={t.id} className="rounded-lg border p-5 space-y-3">
                <h3 className="font-medium">{t.outcome}</h3>
                <p>
                  {t.id} · {t.state}
                </p>
                <ol>
                  {t.criteria.map((c, i) => (
                    <li key={c.use}>
                      {i + 1}. {c.use}
                      <p>Expected proof: {c.proof}</p>
                    </li>
                  ))}
                </ol>
                <p>Out of this ticket: {t.exclusions.join("; ")}</p>
                <p>Depends on: {t.dependencies.join(", ") || "None"}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
