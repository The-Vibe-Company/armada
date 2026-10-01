"use client";

// /validations and /approve/<id> (THE-885): what waits for the owner's check
// (merges to approve, work to validate, questions the coordinator escalated),
// then what they decided this week, with who decided and when. /approve/<id>
// is the link the coordinator sends: one validation, whole, built to be read
// on a phone. Both render from the overview the shell polls, which holds the
// viewer's organization's projects only.
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { filterValidations, hasFilters } from "@/lib/filters";
import type { ActionContext } from "../Actions";
import { FilterBar, useListFilters } from "../FilterBar";
import { CardGrid, Notice, Page, Section, SectionBody } from "../page";
import { useFleet, useNow, useShell } from "../shell/context";
import { ValidationCard } from "./ValidationCard";

function useActionContext(): ActionContext {
  const { overview, failed, refresh, version } = useFleet();
  const { t, author, setAuthor, account } = useShell();
  const now = useNow();
  return {
    t,
    signer: { name: author, set: setAuthor, fixed: account !== null },
    live: overview.live.state === "ok" && !failed,
    now,
    version,
    refresh,
  };
}

export function ValidationsScreen() {
  const { overview } = useFleet();
  const ctx = useActionContext();
  const { t } = ctx;
  const s = t.validations;
  const names = useMemo(() => new Map(overview.projects.map((p) => [p.slug, p.name])), [overview]);
  const { filters } = useListFilters("validations");
  const shown = useMemo(
    () => filterValidations(overview.validations ?? [], filters, names),
    [overview, filters, names],
  );
  const pending = shown.filter((v) => !v.decision);
  const decided = shown.filter((v) => v.decision);
  const filtered = hasFilters(filters);
  // A filter on what was decided leaves out what is still to decide, and the other way round.
  const showPending = !filters.state || filters.state === "pending";
  const showDecided = !filters.mine && filters.state !== "pending";
  return (
    <Page toolbar={<FilterBar list="validations" />}>
      {overview.live.state === "unreachable" && <Notice tone="warn">{t.unreachableBanner(overview.live.error)}</Notice>}
      {showPending && (
        <Section label={s.pendingTitle} count={pending.length}>
          {pending.length === 0 ? (
            <SectionBody>
              <p>{filtered ? t.filters.noMatch : s.empty}</p>
            </SectionBody>
          ) : (
            <CardGrid wide>
              {pending.map((v) => (
                <ValidationCard key={v.id} ctx={ctx} v={v} projectName={names.get(v.project) ?? v.project} />
              ))}
            </CardGrid>
          )}
        </Section>
      )}
      {showDecided && (
        <Section label={s.decidedTitle} count={decided.length}>
          {decided.length === 0 ? (
            <SectionBody>
              <p>{filtered ? t.filters.noMatch : s.decidedEmpty}</p>
            </SectionBody>
          ) : (
            <CardGrid wide>
              {decided.map((v) => (
                <ValidationCard key={v.id} ctx={ctx} v={v} projectName={names.get(v.project) ?? v.project} />
              ))}
            </CardGrid>
          )}
        </Section>
      )}
    </Page>
  );
}

export function ApproveScreen() {
  const { overview } = useFleet();
  const ctx = useActionContext();
  const id = Number(useParams<{ id: string }>().id);
  const v = (overview.validations ?? []).find((x) => x.id === id);
  const name = v ? (overview.projects.find((p) => p.slug === v.project)?.name ?? v.project) : null;
  return (
    <Page>
      {v && name ? (
        <div className="vd-approve">
          <ValidationCard ctx={ctx} v={v} projectName={name} mode="full" />
        </div>
      ) : (
        <Notice>{ctx.t.validations.notFound}</Notice>
      )}
    </Page>
  );
}
