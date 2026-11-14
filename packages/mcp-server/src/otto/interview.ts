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
        sessionGeneration: 0,
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
      const ownerEvents = (
        await sql.query<{ revision: number; event: string; snapshot: OttoInterview; previous: OttoInterview | null }>(
          `select r.revision,r.event,r.snapshot,(select prior.snapshot from public.otto_interview_revisions prior where prior.objective_id=r.objective_id and prior.revision=r.revision-1) as previous from public.otto_interview_revisions r where r.org_id=$1 and r.owner_id=$2 and r.objective_id=$3 and r.event in ('owner_answer','owner_reopened') and ${interviewAuthorization}`,
          params,
        )
      ).rows;
      for (const decision of round.decisions) {
        if (decision.answer === null) continue;
        const binding = decision.ownerAnswer;
        if (!binding || binding.questionId !== decision.id || binding.answer !== decision.answer)
          throw new Error("Settled decisions require a matching durable owner answer");
        const event = ownerEvents.find(
          (candidate) => candidate.event === "owner_answer" && candidate.revision === binding.revision,
        );
        const staleAfterReopen = ownerEvents.some(
          (candidate) =>
            candidate.event === "owner_reopened" &&
            candidate.revision >= binding.revision &&
            wasReopened(candidate.previous?.round, candidate.snapshot.round, decision.id),
        );
        if (staleAfterReopen) throw new Error("Reopened decisions require a new matching owner answer");
        const answer = event?.snapshot.answers.find((candidate) => candidate.revision === binding.revision);
        const frontier = event?.snapshot.round?.frontier ?? [];
        const position = frontier.indexOf(decision.id);
        const asked = event?.snapshot.round?.decisions.find((candidate) => candidate.id === decision.id);
        if (
          !answer ||
          position < 0 ||
          asked?.question !== decision.question ||
          !matchesOwnerAnswer(answer.body, frontier.length, position, binding.answer)
        )
          throw new Error("Settled decision does not match its numbered owner answer");
      }
      for (const decision of settled) {
        const next = round.decisions.find((candidate) => candidate.id === decision.id);
        if (!next) throw new Error("Settled decisions must remain in the design tree");
        const changed = next.answer !== decision.answer || next.source !== decision.source;
        if (changed && (!next.ownerAnswer || next.ownerAnswer.revision <= (decision.ownerAnswer?.revision ?? 0)))
          throw new Error("Changing settled decisions requires a new matching owner answer");
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
    async reopenDecision(expectedRevision: number, decisionId: string): Promise<OttoInterview> {
      const current = await read();
      const decision = current?.round?.decisions.find((candidate) => candidate.id === decisionId);
      if (!current?.round || !decision || decision.answer === null) throw new Error("Settled decision unavailable");
      const reopened = new Set([decisionId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const candidate of current.round.decisions) {
          if (!reopened.has(candidate.id) && candidate.dependsOn.some((id) => reopened.has(id))) {
            reopened.add(candidate.id);
            changed = true;
          }
        }
      }
      const decisions = current.round.decisions.map((candidate) =>
        reopened.has(candidate.id) ? { ...candidate, answer: null, source: null, ownerAnswer: null } : candidate,
      );
      const frontier = decisions
        .filter(
          (candidate) =>
            candidate.answer === null &&
            candidate.dependsOn.every((id) => decisions.find((dependency) => dependency.id === id)?.answer !== null),
        )
        .map((candidate) => candidate.id);
      return update(
        expectedRevision,
        { ...current, revision: expectedRevision + 1, enough: false, round: { ...current.round, decisions, frontier } },
        "owner_reopened",
      );
    },
    async restartSession(expectedRevision: number, previousSandboxId: string): Promise<OttoInterview> {
      const current = await read();
      if (!current || current.revision !== expectedRevision || current.sandboxId !== previousSandboxId)
        throw Error("Interview restart revision conflict");
      const snapshot = {
        ...current,
        revision: current.revision + 1,
        sessionGeneration: (current.sessionGeneration ?? 0) + 1,
        sandboxId: null,
      };
      const row = (
        await sql.query<{ snapshot: OttoInterview }>(
          `with changed as (
        update public.otto_interviews set revision=revision+1,snapshot=$5::jsonb
        where org_id=$1 and owner_id=$2 and objective_id=$3 and revision=$4 and snapshot->>'sandboxId'=$6 and ${interviewAuthorization}
        returning *
      ), retired as (
        update public.otto_intentions set state='retired',result=jsonb_build_object('sandboxId',$6::text,'observed','stopped_or_not_found'),updated_at=now()
        where org_id=$1 and owner_id=$2 and objective_id=$3 and kind='engine_start' and payload->>'sandboxId'=$6
        and exists(select 1 from changed)
      ), journal as (
        insert into public.otto_interview_revisions(objective_id,revision,org_id,owner_id,event,snapshot)
        select objective_id,revision,org_id,owner_id,'session_restarted',snapshot from changed
      ) select snapshot from changed`,
          [...params, expectedRevision, JSON.stringify(snapshot), previousSandboxId],
        )
      ).rows[0];
      if (!row) throw Error("Interview restart revision conflict");
      return row.snapshot;
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

/** Do not infer intent or accept a quoted substring from an unrelated numbered reply. */
function matchesOwnerAnswer(body: string, frontierSize: number, position: number, answer: string): boolean {
  if (/^enough[,\s]+go[.!]?$/i.test(body.trim())) return false;
  const markers = [...body.matchAll(/(?:^|\s)(\d+)(?:[.)](?=\s)|(?=\s))/g)].filter(
    (match) => Number(match[1]) >= 1 && Number(match[1]) <= frontierSize,
  );
  if (markers.length) {
    if (body.slice(0, markers[0]!.index).trim()) return false;
    const numbers = markers.map((marker) => Number(marker[1]));
    if (new Set(numbers).size !== numbers.length) return false;
    const index = numbers.indexOf(position + 1);
    if (index < 0) return false;
    const marker = markers[index]!;
    const text = body.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? body.length).trim();
    return text === answer;
  }
  return frontierSize === 1 && position === 0 && body.trim() === answer;
}

/** Identify the exact invalidated branch, without revoking unrelated pending owner replies. */
function wasReopened(
  before: OttoInterviewRound | null | undefined,
  after: OttoInterviewRound | null,
  id: string,
): boolean {
  const cleared = new Set(
    before?.decisions
      .filter((d) => d.answer !== null && after?.decisions.find((next) => next.id === d.id)?.answer === null)
      .map((d) => d.id),
  );
  const pending = [id],
    visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (cleared.has(current)) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(before?.decisions.find((d) => d.id === current)?.dependsOn ?? []));
  }
  return false;
}
