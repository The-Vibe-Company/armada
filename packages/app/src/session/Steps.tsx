// The six steps of a session (THE-2028), shared by its page and the room's agent lane (THE-2089).
import { cn } from "@/lib/utils";
import { TONES } from "@/session/StateCard";
import { PAGE_STEPS, type PageState } from "@/session/view";

/** The six steps: the done ones grey, the current one in its state's colour and marked, those to come dark. */
export function Steps({ step, group }: { step: number; group: PageState }) {
  return (
    <ol aria-label="Steps" className="m-0 grid list-none grid-cols-6 gap-1.5 p-0">
      {PAGE_STEPS.map((s, k) => {
        const state = k < step ? "done" : k === step ? "current" : "next";
        return (
          <li
            key={s}
            data-step={state}
            aria-current={state === "current" ? "step" : undefined}
            className="flex min-w-0 flex-col gap-1.5"
          >
            <span
              aria-hidden
              className={`h-1 rounded-[1px] ${state === "done" ? "bg-step-done" : state === "current" ? TONES[group].bg : "bg-step-next"}`}
            />
            <span
              className={cn(
                "truncate text-body",
                state === "current" ? "font-medium text-text" : state === "done" ? "text-text-2" : "text-text-3",
              )}
            >
              {s}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
