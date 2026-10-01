import { COMMANDS } from "./content";
import { Terminal } from "./Terminal";
import { TRANSCRIPT } from "./transcript";

const WORDS = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
  "Twenty",
  "Twenty-one",
  "Twenty-two",
  "Twenty-three",
  "Twenty-four",
  "Twenty-five",
];
/** "Twenty commands": the count of `armada --help`, in words while it is small enough. */
export const countWord = (n: number) => WORDS[n] ?? String(n);

const GROUPS = [
  { role: "coordinator", label: "Coordinator" },
  { role: "worker", label: "Worker" },
  { role: "both", label: "Both" },
  { role: "you", label: "You, once" },
] as const;

// The CLI (THE-887): every command of `armada --help`, and a session replayed from Armada's own output.
export function Cli() {
  return (
    <section className="lp-section lp-cli" id="cli" aria-labelledby="lp-cli-title">
      <div className="lp-split is-reverse">
        <div className="lp-split-media lp-reveal">
          <Terminal commands={TRANSCRIPT} title="coordinator · widgets" />
        </div>
        <div className="lp-split-words">
          <span className="lp-eyebrow is-lime lp-reveal">The CLI</span>
          <h2 id="lp-cli-title" className="lp-h2 lp-reveal">
            {countWord(COMMANDS.length)} commands. Every agent speaks them.
          </h2>
          <p className="lp-body lp-reveal">
            Workers write to Linear only through Armada, so every claim, report and question lands in the same format.
            When a command cannot go on, it prints the reason and the next command to run.
          </p>
          <div className="lp-commands lp-reveal">
            {GROUPS.map((g) => (
              <div key={g.role} className="lp-command-group">
                <span className="lp-command-role">{g.label}</span>
                <ul>
                  {COMMANDS.filter((c) => c.role === g.role).map((c) => (
                    <li key={c.name} className="lp-command" data-what={c.what}>
                      <code>{c.name}</code>
                      <span className="sr-only">: {c.what}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
