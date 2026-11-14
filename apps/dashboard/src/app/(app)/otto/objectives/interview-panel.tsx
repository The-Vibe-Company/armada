import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { type InterviewView, interviewRequest, updateInterview } from "./interview-panel-actions";

/** The interview remains readable without a live engine context. Manual refresh never starts a turn. */
export async function InterviewPanel({ orgId, id }: { orgId: string; id: string }) {
  let view: InterviewView;
  try {
    view = await interviewRequest(orgId, id);
  } catch {
    return (
      <section aria-label="Interview">
        <h2 className="font-medium">Interview unavailable</h2>
        <p className="text-sm text-muted-foreground">
          Your objective is saved. Refresh to retry loading the interview.
        </p>
      </section>
    );
  }
  const { interview, effects, goldens } = view;
  const hidden = (
    <>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="id" value={id} />
    </>
  );
  return (
    <section aria-labelledby="interview-heading" className="space-y-5 rounded-lg border p-5">
      <div className="space-y-2">
        <h2 id="interview-heading" className="font-medium">
          Decide with Otto
        </h2>
        <p className="text-sm text-muted-foreground">
          Numbered decisions, recommended answers, and sources stay here when the engine loses context. No workers start
          from this interview.
        </p>
        <Link href="/otto/engine" className="text-sm underline">
          Choose or inspect engine settings
        </Link>
      </div>
      {!interview ? (
        <ActionForm
          action={updateInterview}
          className="space-y-3"
          focusError
          footer={<SubmitButton disabled={!goldens.length}>Start interview</SubmitButton>}
        >
          {hidden}
          <input type="hidden" name="action" value="start" />
          <Label htmlFor="interview-golden">Connected snapshot</Label>
          <NativeSelect id="interview-golden" name="goldenId" required defaultValue="">
            <option value="" disabled>
              Choose a snapshot
            </option>
            {goldens.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.provider})
              </option>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            Uses your selected engine and the unchanged grilling skill through Skillpack. Requires a connected Skillpack
            account.
          </p>
        </ActionForm>
      ) : (
        <>
          <details className="text-sm">
            <summary className="cursor-pointer">Engine session and access</summary>
            <dl className="mt-2 space-y-1 break-all">
              <dt>Engine</dt>
              <dd>
                {interview.engine.harness} · {interview.engine.model}
              </dd>
              <dt>Model account reference</dt>
              <dd>{interview.engine.credentialId}</dd>
              <dt>Sandbox</dt>
              <dd>{interview.sandboxId ?? "Not yet bound"}</dd>
              <dt>Access</dt>
              <dd>Interview tools and read-only repository facts. No GitHub credential is delivered to Otto.</dd>
              <dt>Requested skill</dt>
              <dd>grilling@1.1.1 (unchanged Skillpack package)</dd>
              <dt>Observed installation receipts</dt>
              <dd>
                {effects.flatMap((e) => e.skills ?? []).length
                  ? effects
                      .flatMap((e) => e.skills ?? [])
                      .map((skill) => (
                        <p key={skill.reference}>
                          {skill.reference} · {skill.version} · {skill.checksum}
                        </p>
                      ))
                  : "No installation receipt observed yet."}
              </dd>
            </dl>
          </details>
          {effects.some((e) => e.state === "unknown" || e.state === "dispatching") && (
            <p role="status" className="text-sm">
              An effect is awaiting reconciliation. A bound session is not proof that launch or delivery succeeded. No
              duplicate session will be launched.
            </p>
          )}
          {effects.some((e) => e.kind === "engine_message" && e.state === "pending") && (
            <p role="status" className="text-sm">
              Your answers are saved pending delivery. When Otto finishes the current turn, use Continue from saved
              state.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Saved revision {interview.revision}
            {interview.enough ? " · Enough, go recorded; irreversible choices remain unresolved." : ""}
          </p>
          {interview.round ? (
            <>
              <ol className="list-decimal space-y-5 pl-5">
                {interview.round.frontier.map((key) => {
                  const d = interview.round!.decisions.find((d) => d.id === key)!;
                  return (
                    <li key={key}>
                      <p className="whitespace-pre-wrap font-medium">{d.question}</p>
                      <p className="mt-1 text-sm">Recommended: {d.recommendation}</p>
                    </li>
                  );
                })}
              </ol>
              {!interview.round.frontier.length && (
                <p className="text-sm">No remaining decision frontier. This does not mean the objective is complete.</p>
              )}
              <details>
                <summary className="cursor-pointer text-sm">
                  Settled decisions, sources and reversible assumptions
                </summary>
                <ul className="mt-3 space-y-3 text-sm">
                  {interview.round.decisions
                    .filter((d) => d.answer !== null)
                    .map((d) => (
                      <li key={d.id}>
                        <p>
                          {d.question}: {d.answer}
                        </p>
                        <p className="text-muted-foreground">
                          Source: {d.source} · {d.reversible ? "Reversible" : "Hard to undo"}
                        </p>
                      </li>
                    ))}
                  {interview.round.assumptions.map((a) => (
                    <li key={a.text}>
                      Assumed: {a.text}
                      <p className="text-muted-foreground">Source: {a.source}</p>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Waiting for the first round. Refresh to load observed state.
            </p>
          )}
          <details>
            <summary className="cursor-pointer text-sm">Your saved answers</summary>
            <ol className="mt-3 space-y-3 text-sm">
              {interview.answers.map((a) => (
                <li key={a.revision} className="whitespace-pre-wrap">
                  {a.body}
                </li>
              ))}
            </ol>
          </details>
          <ActionForm
            action={updateInterview}
            className="space-y-3"
            focusError
            resetOnSuccess
            footer={<SubmitButton>Save and send answers</SubmitButton>}
          >
            {hidden}
            <input type="hidden" name="action" value="answer" />
            <input type="hidden" name="revision" value={interview.revision} />
            <Label htmlFor="interview-answer">Answer by number, or say “enough, go”</Label>
            <Textarea id="interview-answer" name="body" maxLength={20000} required rows={3} />
          </ActionForm>
          <ActionForm action={updateInterview} footer={<SubmitButton>Continue from saved state</SubmitButton>}>
            {hidden}
            <input
              type="hidden"
              name="action"
              value={effects.some((e) => e.kind === "engine_start" && e.state === "succeeded") ? "resume" : "start"}
            />
          </ActionForm>
        </>
      )}
    </section>
  );
}
