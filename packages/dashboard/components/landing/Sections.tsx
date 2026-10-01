import Link from "next/link";
import { CopyCommand } from "./Copy";
import { CrewSky } from "./CrewSky";
import { CIPHER, COMPANY, DOCS, LAUNCH_TOKEN_HOURS, RELEASES, REPOSITORY, SETUP, VERSION } from "./content";
import { GitHubIcon } from "./Hero";
import { Mark } from "./Mark";

// The landing's quieter sections (THE-887): coordinators and workers, the keys, the install and the footer.

export function Crew() {
  return (
    <section className="lp-section" aria-labelledby="lp-crew-title">
      <div className="lp-split">
        <div className="lp-split-words">
          <span className="lp-eyebrow is-amber lp-reveal">Coordinators and workers</span>
          <h2 id="lp-crew-title" className="lp-h2 lp-reveal">
            One coordinator per project. As many workers as you need.
          </h2>
          <p className="lp-body lp-reveal">
            The coordinator briefs and launches workers, carries your answers and merges. Each worker holds one ticket,
            reports every phase, asks when it is unsure and hands back a green pull request.
          </p>
          <dl className="lp-roles lp-reveal">
            <div>
              <dt>
                <i className="lp-role-mark is-coordinator" />
                Coordinator
              </dt>
              <dd className="lp-mono">brief · watch · answer · merge</dd>
            </div>
            <div>
              <dt>
                <i className="lp-role-mark is-worker" />
                Worker
              </dt>
              <dd className="lp-mono">claim · report · ask · release</dd>
            </div>
            <div>
              <dt>
                <i className="lp-role-mark is-you" />
                You
              </dt>
              <dd>answer, approve, launch and merge from the dashboard</dd>
            </div>
          </dl>
        </div>
        <div className="lp-split-media lp-crew lp-reveal">
          <CrewSky />
          <ul className="lp-crew-legend" aria-label="What flies">
            <li>
              <i style={{ background: "var(--frontier)" }} />
              brief, answer
            </li>
            <li>
              <i style={{ background: "var(--accent)" }} />
              question
            </li>
            <li>
              <i style={{ background: "var(--done)" }} />
              green hand-back, merged
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

export function Keys() {
  return (
    <section className="lp-section" id="keys" aria-labelledby="lp-keys-title">
      <div className="lp-keys">
        <div className="lp-keys-head">
          <h2 id="lp-keys-title" className="lp-h2 lp-reveal">
            Your keys stay in Armada. Not on laptops, not in prompts.
          </h2>
          <p className="lp-body lp-reveal">
            Enter the Linear key once. Terminals sign in, workers get a one-time token, and Armada hands each command
            only the keys it needs.
          </p>
        </div>
        <div className="lp-facts">
          <div className="lp-fact lp-reveal">
            <span className="lp-fact-figure">{LAUNCH_TOKEN_HOURS} hour</span>
            <p>
              A launch token covers one ticket, works once and expires after an hour. Only the prompt handed to the
              worker carries it; everywhere else it shows masked.
            </p>
          </div>
          <div className="lp-fact lp-reveal">
            <span className="lp-fact-figure">1 ticket</span>
            <p>
              A worker session can claim, report, ask and release its own ticket, and nothing else. It ends on release,
              on merge, or when you revoke it.
            </p>
          </div>
          <div className="lp-fact lp-reveal">
            <span className="lp-fact-figure is-mono">{CIPHER}</span>
            <p>
              Each key is sealed with its own data key. No page or log ever shows it again, and every handout is in the
              audit list.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Install() {
  return (
    <section className="lp-section lp-install" id="install" aria-labelledby="lp-install-title">
      <div className="lp-install-inner">
        <Mark size={56} className="lp-reveal" />
        <h2 id="lp-install-title" className="lp-install-title lp-reveal">
          Launch your fleet.
        </h2>
        <p className="lp-body lp-reveal">
          Three commands, and a repository is ready for its first worker: one pull request adds what it lacks.
        </p>
        <ol className="lp-install-steps lp-reveal">
          {SETUP.map((s, k) => (
            <li key={s.command}>
              <span className="lp-install-n lp-mono">{String(k + 1).padStart(2, "0")}</span>
              <CopyCommand command={s.command} note={s.note} />
            </li>
          ))}
        </ol>
        <div className="lp-install-actions lp-reveal">
          <a href={`${REPOSITORY}#set-up`} className="lp-button is-lime is-lg">
            Read the setup guide
            <span aria-hidden>→</span>
          </a>
          <Link href="/login" className="lp-button is-ghost is-lg">
            Sign in
          </Link>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="lp-footer">
      <div className="lp-footer-inner">
        <span className="lp-brand">
          <Mark size={18} />
          Armada
        </span>
        <span className="lp-dim">
          v{VERSION} · MIT · by{" "}
          <a href={COMPANY} className="lp-footer-link">
            The Vibe Company
          </a>
        </span>
        <span className="lp-grow" />
        <nav className="lp-footer-nav" aria-label="Armada elsewhere">
          <a href={REPOSITORY} className="lp-footer-link">
            <GitHubIcon />
            GitHub
          </a>
          <a href={RELEASES} className="lp-footer-link">
            Releases
          </a>
          <a href={DOCS} className="lp-footer-link">
            Docs
          </a>
          <Link href="/login" className="lp-footer-link">
            Sign in
          </Link>
        </nav>
      </div>
    </footer>
  );
}
