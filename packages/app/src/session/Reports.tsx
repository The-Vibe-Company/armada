// A session's reports and events (THE-2028), newest first, shared by its page
// and the room's agent lane (THE-2089).
import { cn } from "@/lib/utils";
import type { Entry } from "@/session/view";

/** A quiet line where a list has nothing to show. */
export const Quiet = ({ text }: { text: string }) => (
  <p className="m-0 py-6 text-center text-body text-text-3">{text}</p>
);

/** Each report or event on one line, its text cut with an ellipsis; a click opens the whole of it. */
export function Reports({ entries, at }: { entries: readonly Entry[]; at: (time: string | null) => string }) {
  if (!entries.length) return <Quiet text="No report yet." />;
  const line =
    "grid min-h-10 grid-cols-[minmax(52px,max-content)_minmax(0,max-content)_minmax(0,1fr)] items-center gap-3.5 px-1";
  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {entries.map((e) => {
        const head = (
          <>
            <span className="whitespace-nowrap font-mono text-body text-text-3 tnum">{at(e.at)}</span>
            <span className="truncate text-body text-text">{e.title}</span>
            <span className="truncate text-body text-text-2">{firstLine(e.body)}</span>
          </>
        );
        return (
          <li key={e.seq} data-entry={e.seq} className="border-line-soft border-b">
            {e.body.trim() ? (
              <details className="group">
                <summary
                  className={cn(line, "cursor-pointer list-none hover:bg-hover [&::-webkit-details-marker]:hidden")}
                >
                  {head}
                </summary>
                <p className="m-0 whitespace-pre-wrap px-1 pb-3 text-body text-text-soft">{e.body.trim()}</p>
              </details>
            ) : (
              <div className={line}>{head}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const firstLine = (text: string) =>
  text
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";
