"use client";

// /validations and /approve/<id> (THE-885): what waits for the owner's check
// (merges to approve, work to validate, questions the coordinator escalated),
// then what they decided this week, with who decided and when. /approve/<id>
// is the link the coordinator sends: one validation, whole, built to be read
// on a phone. Both render from the overview the shell polls, which holds the
// viewer's organization's projects only.
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { decidedValidations, pendingValidations } from "@/lib/overview-view";
import type { ActionContext } from "../Actions";
import { CardGrid, LONG_LIST, Notice, Page, Section, SectionBody } from "../page";
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
  const names = new Map(overview.projects.map((p) => [p.slug, p.name]));
  const pending = useMemo(() => pendingValidations(overview), [overview]);
  const decided = useMemo(() => decidedValidations(overview), [overview]);
  return (
    <Page>
      {overview.live.state === "unreachable" && <Notice tone="warn">{t.unreachableBanner(overview.live.error)}</Notice>}
      <Section label={s.pendingTitle} count={pending.length}>
        {pending.length === 0 ? (
          <SectionBody>
            <p>{s.empty}</p>
          </SectionBody>
        ) : (
          <CardGrid wide>
            {pending.map((v) => (
              <ValidationCard key={v.id} ctx={ctx} v={v} projectName={names.get(v.project) ?? v.project} />
            ))}
          </CardGrid>
        )}
      </Section>
      <Section label={s.decidedTitle} count={decided.length}>
        {decided.length === 0 ? (
          <SectionBody>
            <p>{s.decidedEmpty}</p>
          </SectionBody>
        ) : (
          <CardGrid wide long={decided.length > LONG_LIST}>
            {decided.map((v) => (
              <ValidationCard key={v.id} ctx={ctx} v={v} projectName={names.get(v.project) ?? v.project} />
            ))}
          </CardGrid>
        )}
      </Section>
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
