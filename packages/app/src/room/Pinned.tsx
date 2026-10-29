// The question waiting for the owner, pinned under the sky (THE-1996): who
// asks (the ticket's triangle, id, title, harness), when, the question, its
// choices as buttons (the recommended one primary) and a labelled note. A
// choice records the owner's answer; the subscription then takes the card away.
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Harness } from "@/fleet/sky";
import type { FoldedInboxItem } from "@/fleet/state";
import { HarnessName, Ship } from "./Ship";
import { parseQuestion } from "./view";

export function Pinned({
  item,
  waiting,
  title,
  harness,
  time,
  answer,
}: {
  item: FoldedInboxItem;
  /** How many questions wait, this one included: the others come next. */
  waiting: number;
  title: string | null;
  harness: Harness | null;
  time: string;
  answer: (item: string, choice: string, note: string) => Promise<void>;
}) {
  const field = useId();
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { question, choices } = parseQuestion(item.body);

  /** Without choices, the note is the answer itself, not a note beside it. */
  async function choose(choice: string, withNote = true) {
    setSending(true);
    setProblem(null);
    try {
      await answer(item.id, choice, withNote ? note : "");
      setNote("");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The answer was not recorded. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section aria-label="A question waiting for you" className="flex-none border-line border-b px-7 py-3" data-pinned>
      <div className="rounded-md bg-card px-3.5 pt-3 pb-3.5 shadow-ring">
        <div className="mb-1.5 flex min-w-0 items-center gap-2 text-body text-text-2">
          <Ship harness={harness} />
          <span className="flex-none font-mono text-meta text-text">{item.ticket}</span>
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {harness && <HarnessName harness={harness} />}
          {waiting > 1 && <span className="flex-none text-text-3">1 of {waiting}</span>}
          <span className="flex-none font-mono text-meta text-text-3 tnum">{time}</span>
        </div>
        <p className="m-0 mb-2.5 whitespace-pre-wrap text-sub text-text">{question}</p>
        {choices.length > 0 && (
          <div className="mb-2.5 flex flex-wrap gap-2" data-choices>
            {choices.map((c) => (
              <Button
                key={c.label}
                variant={c.recommended ? "primary" : "soft"}
                disabled={sending}
                onClick={() => choose(c.label)}
                className="h-8 px-3.5 text-sub"
              >
                {c.label}
                {c.recommended && <span className="font-normal text-body opacity-75">· recommended</span>}
              </Button>
            ))}
          </div>
        )}
        <form
          className="flex items-center gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            // Enter answers a question without choices; with choices, a button does.
            if (!choices.length && note.trim() && !sending) choose(note.trim(), false);
          }}
        >
          <label htmlFor={`${field}-note`} className="w-11 flex-none text-body text-text-2">
            Note
          </label>
          <input
            id={`${field}-note`}
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={choices.length ? 4096 : 1024}
            placeholder={choices.length ? "Add a note…" : "Your answer…"}
            disabled={sending}
            className="h-8.5 min-w-0 flex-1 rounded-sm bg-bg px-3 text-sub text-text shadow-ring placeholder:text-text-3"
          />
          {choices.length === 0 && (
            <Button type="submit" variant="primary" disabled={sending || !note.trim()}>
              Answer
            </Button>
          )}
        </form>
        {problem && (
          <p role="alert" className="m-0 mt-2 text-body text-red">
            {problem}
          </p>
        )}
      </div>
    </section>
  );
}
