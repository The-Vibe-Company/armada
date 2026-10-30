// The question waiting for the owner, said above the owner's field (THE-2085)
// while its card in the panel's Agents is not on screen, so the panel closed
// never hides it: who asks, the question on one line, and Answer, which opens
// the card.
import { Button } from "@/components/ui/button";
import type { FoldedInboxItem } from "@/fleet/state";
import { parseQuestion } from "./view";

export function Asking({
  item,
  waiting,
  onAnswer,
}: {
  item: FoldedInboxItem;
  /** How many questions wait, this one included. */
  waiting: number;
  onAnswer: () => void;
}) {
  const { question } = parseQuestion(item.body);
  return (
    <section aria-label="Waiting for your answer" className="flex-none px-3 pb-2 sm:px-12" data-asking>
      <div className="mx-auto flex w-full max-w-(--chat-content-max-width) items-center gap-2.5 rounded-md bg-card py-1.5 pr-1.5 pl-3 text-body shadow-ring">
        <span aria-hidden className="size-1.75 flex-none rounded-full bg-amber" />
        <span className="flex-none font-mono text-meta text-text">{item.ticket}</span>
        <span className="min-w-0 flex-1 truncate text-text-2">{question}</span>
        {waiting > 1 && <span className="flex-none text-text-3">1 of {waiting}</span>}
        <Button variant="soft" onClick={onAnswer} className="h-6.5 flex-none px-2.5">
          Answer
        </Button>
      </div>
    </section>
  );
}
