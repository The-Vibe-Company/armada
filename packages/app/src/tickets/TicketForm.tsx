// The new ticket's form and a ticket's edit form (THE-2124), in the Tickets
// page's panel: title, description in Markdown, labels, parent, and for a new
// ticket "ready to launch". The daemon's refusal shows in red under it.
import { useId, useState } from "react";
import { Field, Form, Input } from "@/components/page";
import { Button } from "@/components/ui/button";
import type { Translate } from "@/lib/i18n";
import type { TicketDraft } from "./view";

const textarea =
  "min-h-36 w-full min-w-0 resize-y rounded-control bg-sunken px-2.5 py-1.5 font-mono text-body text-text leading-relaxed shadow-ring outline-none placeholder:text-text-3 focus-visible:shadow-ring-hover disabled:opacity-50";

export function TicketForm({
  initial,
  creating,
  t,
  onSubmit,
  onDiscard,
}: {
  initial: TicketDraft;
  /** A new ticket: "ready to launch" and Create; else Save. */
  creating: boolean;
  t: Translate;
  /** Resolves once the daemon saved it; rejects with the line to show. */
  onSubmit: (draft: TicketDraft) => Promise<void>;
  onDiscard: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const set = <K extends keyof TicketDraft>(key: K, value: TicketDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  return (
    <Form
      className="px-4 py-4"
      data-ticket-form={creating ? "new" : "edit"}
      onSubmit={(e) => {
        e.preventDefault();
        if (!draft.title.trim()) return setProblem(t("tickets.form.needsTitle"));
        setSaving(true);
        setProblem(null);
        onSubmit(draft)
          .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
          .finally(() => setSaving(false));
      }}
    >
      <Field label={t("tickets.form.title")} htmlFor={`${id}-title`}>
        <Input
          id={`${id}-title`}
          name="title"
          value={draft.title}
          onChange={(e) => set("title", e.target.value)}
          disabled={saving}
          autoComplete="off"
        />
      </Field>
      <Field
        label={t("tickets.form.description")}
        hint={t("tickets.form.descriptionHint")}
        htmlFor={`${id}-description`}
      >
        <textarea
          id={`${id}-description`}
          name="description"
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
          disabled={saving}
          className={textarea}
        />
      </Field>
      <Field label={t("tickets.form.labels")} hint={t("tickets.form.labelsHint")} htmlFor={`${id}-labels`}>
        <Input
          id={`${id}-labels`}
          name="labels"
          value={draft.labels}
          onChange={(e) => set("labels", e.target.value)}
          disabled={saving}
          autoComplete="off"
        />
      </Field>
      <Field label={t("tickets.form.parent")} hint={t("tickets.form.parentHint")} htmlFor={`${id}-parent`}>
        <Input
          id={`${id}-parent`}
          name="parent"
          value={draft.parent}
          onChange={(e) => set("parent", e.target.value)}
          disabled={saving}
          autoComplete="off"
          className="font-mono"
        />
      </Field>
      {creating && (
        <label className="flex cursor-pointer items-center gap-2 text-body text-text-2">
          <input
            type="checkbox"
            name="ready"
            checked={draft.ready}
            onChange={(e) => set("ready", e.target.checked)}
            disabled={saving}
            className="size-3.5 accent-green"
          />
          {t("tickets.form.ready")}
        </label>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? t("tickets.form.saving") : creating ? t("tickets.form.create") : t("tickets.form.save")}
        </Button>
        <Button type="button" variant="ghost" onClick={onDiscard} disabled={saving}>
          {t("tickets.form.discard")}
        </Button>
      </div>
      {problem && (
        <p role="alert" data-ticket-problem className="m-0 text-body text-red">
          {problem}
        </p>
      )}
    </Form>
  );
}
