import Link from "next/link";
import { CopyCommand } from "./Copy";
import { SETUP, SETUP_GUIDE } from "./content";
import { Line } from "./Line";
import { Terminal } from "./Terminal";
import { TRANSCRIPT } from "./transcript";

// The end of the diff (split-diff direction): where a review ends, the step to
// take. Sign in in the browser, or the CLI path as five added lines, beside the
// session the CLI's own code printed.

export function Review() {
  return (
    <section id="install" className="dx-review" aria-labelledby="install-title">
      <div className="dx-review-words">
        <h2 id="install-title" className="dx-review-title">
          <span className="dx-label">Install</span>
          <span className="dx-review-name">Launch your first agent.</span>
        </h2>
        <p className="dx-review-lead">
          Sign in, connect Boat or Modal to your org, store your agent's key and connect GitHub. Then build a golden and
          launch.
        </p>
        <div className="dx-review-actions">
          <Link href="/login" className="lp-button is-lg dx-approve">
            Sign in to try Armada
          </Link>
          <a href={SETUP_GUIDE} className="lp-button is-ghost is-lg">
            Read the setup guide
          </a>
        </div>
      </div>
      <div className="dx-review-cli">
        <h3 className="dx-review-sub">Or from your terminal</h3>
        <ol className="dx-steps">
          {SETUP.map((s, k) => (
            <li key={s.command}>
              <Line kind="add" no={k + 1} block>
                <CopyCommand command={s.command} note={s.note} words />
              </Line>
            </li>
          ))}
        </ol>
      </div>
      <div className="dx-review-terminal">
        <Terminal commands={TRANSCRIPT} title="armada · widgets" />
      </div>
    </section>
  );
}
