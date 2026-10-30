// The empty room's hero (THE-2055), after T3 Code's draft hero
// (`DraftHeroHeadline.tsx`): with nothing said yet, the thread's place holds
// "What should we work on?" above the owner's field, centred, with the fleet's
// sentence under it (THE-2085: the room's header lost its quiet line), and the starter
// asks the fleet's facts justify under it (`starterAsks` in view.ts). A chip
// sends its words as the field would. The room keeps the field in the same
// place in both layouts, so on the first Send it glides down to its dock.
import { useState } from "react";
import type { StarterAsk } from "./view";

const HERO_HEADLINE = "What should we work on?";

/** The headline and the fleet's sentence, at the bottom of the space above the field. */
export function HeroHeadline({ sentence }: { sentence?: string | null }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end px-3 pb-5 sm:px-12" data-hero>
      <h2 className="m-0 text-balance text-center font-normal text-hero text-text sm:text-hero-lg">{HERO_HEADLINE}</h2>
      {sentence && <p className="m-0 mt-2 text-balance text-center text-sub text-text-2">{sentence}</p>}
    </div>
  );
}

/** The starter asks, at the top of the space under the field; a chip sends its text. */
export function StarterAsks({
  asks,
  send,
  disabled,
  sent,
}: {
  asks: readonly StarterAsk[];
  send: (body: string) => Promise<void>;
  /** Sent: the chips leave with the hero, so the focus goes on to the owner's field. */
  sent?: () => void;
  /** The field is disabled (no coordinator, no connection): so are the chips. */
  disabled: boolean;
}) {
  const [sending, setSending] = useState<StarterAsk | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  async function ask(text: StarterAsk) {
    if (sending || disabled) return;
    setSending(text);
    setProblem(null);
    try {
      await send(text);
      sent?.();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The message was not sent. Try again.");
    } finally {
      setSending(null);
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 sm:px-12">
      <ul aria-label="Starter asks" className="m-0 flex list-none flex-wrap justify-center gap-2 p-0" data-asks>
        {asks.map((text) => (
          <li key={text}>
            <button
              type="button"
              onClick={() => void ask(text)}
              disabled={disabled || sending !== null}
              aria-busy={sending === text || undefined}
              className="h-item cursor-pointer rounded-full bg-fill px-3.5 text-body text-text-2 shadow-ring transition-colors hover:bg-fill-2 hover:text-text disabled:cursor-default disabled:opacity-60 disabled:hover:bg-fill disabled:hover:text-text-2"
            >
              {text}
            </button>
          </li>
        ))}
      </ul>
      {problem && (
        <p role="alert" className="m-0 pt-2 text-center text-body text-red">
          {problem}
        </p>
      )}
    </div>
  );
}
