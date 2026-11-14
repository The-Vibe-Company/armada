"use client";
import type { OttoWait } from "@armada/core";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { answerWait } from "./actions";

export function QuestionPanel({ wait, orgId }: { wait: OttoWait; orgId: string }) {
  const answerable = wait.status === "open" || wait.status === "parked";
  return (
    <article className="space-y-4 rounded-lg border p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <Link className="underline underline-offset-4" href={`/otto/objectives/${wait.objective_id}`}>
          Open objective
        </Link>
        <span>
          {wait.status} · {wait.reason.replaceAll("_", " ")}
        </span>
      </div>
      <h2 className="font-medium whitespace-pre-wrap break-words">{wait.question}</h2>
      <p className="text-sm text-muted-foreground">
        Deadline:{" "}
        <time dateTime={wait.deadline_at}>
          {new Date(wait.deadline_at).toLocaleString("en-US", { timeZone: "UTC" })} UTC
        </time>
        .{" "}
        {wait.default_choice
          ? `Default: ${wait.choices.find((c) => c.id === wait.default_choice)?.label}.`
          : "No automatic approval. Unanswered questions park this work."}
      </p>
      {wait.reminded_at && (
        <p className="text-sm text-muted-foreground">24-hour reminder recorded. No further reminders.</p>
      )}
      {wait.resolution && <p className="text-sm">Recorded outcome: {wait.resolution}</p>}
      {wait.connection_url && answerable && (
        <Link className="inline-block underline underline-offset-4" href={wait.connection_url}>
          Connect access securely
        </Link>
      )}
      {answerable && wait.kind === "human" && (
        <ActionForm
          action={answerWait}
          focusError
          className="space-y-3"
          footer={<SubmitButton>Save answer</SubmitButton>}
        >
          <input type="hidden" name="org" value={orgId} />
          <input type="hidden" name="id" value={wait.id} />
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm">Choose an answer</legend>
            {wait.choices.map((choice) => (
              <label
                key={choice.id}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2"
              >
                <input type="radio" name="choice" value={choice.id} required />
                {choice.label}
                {choice.id === wait.default_choice ? " (default)" : ""}
              </label>
            ))}
          </fieldset>
        </ActionForm>
      )}
      <p className="text-xs text-muted-foreground">
        Never enter a password, key or token in the objective thread. Access is connected only through settings.
      </p>
    </article>
  );
}
