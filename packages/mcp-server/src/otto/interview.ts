import type { Sql } from "@armada/core/server";
import type { OttoEngine } from "../../../core/src/otto/engine.ts";
import type { OttoInterview, OttoInterviewRound } from "../../../core/src/otto/interview.ts";

export interface OttoInterviewScope {
  orgId: string;
  ownerId: string;
  objectiveId: string;
}
/** SQL bypasses RLS. Recheck current objective ownership and membership at every boundary. */
export const interviewAuthorization = `exists(select 1 from public.otto_objectives o join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id where o.org_id=$1 and o.owner_id=$2 and o.id=$3)`;
export function interviewStore(sql: Sql, scope: OttoInterviewScope) {
  const params = [scope.orgId, scope.ownerId, scope.objectiveId];
  async function read(): Promise<OttoInterview | null> {
    return (
      (
        await sql.query<{ snapshot: OttoInterview }>(
          `select snapshot from public.otto_interviews where org_id=$1 and owner_id=$2 and objective_id=$3 and ${interviewAuthorization}`,
          params,
        )
      ).rows[0]?.snapshot ?? null
    );
  }
  async function update(expectedRevision: number, snapshot: OttoInterview, event: string) {
    const row = (
      await sql.query<{ snapshot: OttoInterview }>(
        `with changed as (
      update public.otto_interviews set revision=revision+1,snapshot=$5::jsonb
      where org_id=$1 and owner_id=$2 and objective_id=$3 and revision=$4 and ${interviewAuthorization}
      returning *
    ), journal as (
      insert into public.otto_interview_revisions(objective_id,revision,org_id,owner_id,event,snapshot)
      select objective_id,revision,org_id,owner_id,$6,snapshot from changed
    ) select snapshot from changed`,
        [...params, expectedRevision, JSON.stringify(snapshot), event],
      )
    ).rows[0];
    if (!row) throw new Error("Interview revision conflict or unavailable objective");
    return row.snapshot;
  }
  return {
    read,
    async start(engine: OttoEngine, goldenId: string): Promise<OttoInterview> {
      const snapshot: OttoInterview = {
        objectiveId: scope.objectiveId,
        revision: 1,
        engine,
        goldenId,
        sandboxId: null,
        round: null,
        answers: [],
        enough: false,
      };
      await sql.query(
        `with created as (
        insert into public.otto_interviews(org_id,owner_id,objective_id,revision,snapshot)
        select $1,$2,$3,1,$4::jsonb where ${interviewAuthorization}
        on conflict(objective_id) do nothing returning *
      ) insert into public.otto_interview_revisions(objective_id,revision,org_id,owner_id,event,snapshot)
        select objective_id,revision,org_id,owner_id,'started',snapshot from created`,
        [...params, JSON.stringify(snapshot)],
      );
      const current = await read();
      if (!current) throw new Error("Interview objective unavailable");
      return current;
    },
    async publish(expectedRevision: number, round: OttoInterviewRound): Promise<OttoInterview> {
      validateRound(round);
      const current = await read();
      if (!current) throw new Error("Interview unavailable");
      const settled = current.round?.decisions.filter((decision) => decision.answer !== null) ?? [];
      if (settled.length) {
        const lastRound = (
          await sql.query<{ revision: number }>(
            `select revision from public.otto_interview_revisions where org_id=$1 and owner_id=$2 and objective_id=$3 and event='round' and ${interviewAuthorization} order by revision desc limit 1`,
            params,
          )
        ).rows[0];
        const ownerReconsidered = current.answers.some((answer) => answer.revision > (lastRound?.revision ?? 0));
        for (const decision of settled) {
          const next = round.decisions.find((candidate) => candidate.id === decision.id);
          if (!next) throw new Error("Settled decisions must remain in the design tree");
          if (!ownerReconsidered && (next.answer !== decision.answer || next.source !== decision.source))
            throw new Error("Changing settled decisions requires a new owner answer");
        }
      }
      return update(expectedRevision, { ...current, revision: expectedRevision + 1, round }, "round");
    },
    async answer(expectedRevision: number, body: string, enough: boolean): Promise<OttoInterview> {
      if (!body.trim()) throw new Error("Answer is empty");
      const current = await read();
      if (!current) throw new Error("Interview unavailable");
      return update(
        expectedRevision,
        {
          ...current,
          revision: expectedRevision + 1,
          enough: current.enough || enough,
          answers: [...current.answers, { revision: expectedRevision + 1, body, enough }],
        },
        "owner_answer",
      );
    },
    async bindSession(sandboxId: string): Promise<void> {
      const current = await read();
      if (!current) throw new Error("Interview unavailable");
      if (current.sandboxId === sandboxId) return;
      if (current.sandboxId) throw new Error("Interview session already bound");
      await update(current.revision, { ...current, revision: current.revision + 1, sandboxId }, "session_bound");
    },
  };
}
function validateRound(round: OttoInterviewRound): void {
  const ids = new Set(round.decisions.map((d) => d.id));
  if (ids.size !== round.decisions.length || ids.has("")) throw new Error("Decision IDs must be unique");
  const decisions = new Map(round.decisions.map((d) => [d.id, d]));
  for (const d of round.decisions) {
    if (!d.question.trim() || !d.recommendation.trim() || d.dependsOn.some((id) => !ids.has(id) || id === d.id))
      throw new Error("Invalid decision");
    if (d.answer !== null && !d.source?.trim()) throw new Error("Settled decisions require a source");
  }
  const visit = (id: string, path: Set<string>): void => {
    if (path.has(id)) throw new Error("Cyclic decision dependencies");
    const next = new Set(path).add(id);
    for (const dependency of decisions.get(id)!.dependsOn) visit(dependency, next);
  };
  for (const id of ids) visit(id, new Set());
  const ready = round.decisions
    .filter((d) => d.answer === null && d.dependsOn.every((id) => decisions.get(id)!.answer !== null))
    .map((d) => d.id);
  if (
    new Set(round.frontier).size !== round.frontier.length ||
    ready.length !== round.frontier.length ||
    round.frontier.some((id) => !ready.includes(id))
  )
    throw new Error("Frontier must contain exactly the answerable decisions");
  if (new Set(round.assumptions.map((assumption) => assumption.text)).size !== round.assumptions.length)
    throw new Error("Assumption text must be unique");
  if (round.assumptions.some((a) => !a.text.trim() || !a.source.trim()))
    throw new Error("Assumptions require provenance");
}
