import Link from "next/link";
import { CopyCommand } from "./Copy";
import { CrewSky } from "./CrewSky";
import {
  CIPHER,
  COMPANY,
  DOCS,
  GITHUB_TOKEN_HOURS,
  RELEASES,
  REPOSITORY,
  SETUP,
  SETUP_GUIDE,
  VERSION,
} from "./content";
import { GitHubIcon } from "./Hero";
import { Mark } from "./Mark";

// The landing's quieter sections (THE-887, #564): orchestrators and agents, the keys, the install and the footer.

export function Crew() {
  return (
    <section className="lp-section" aria-labelledby="lp-crew-title">
      <div className="lp-split">
        <div className="lp-split-words">
          <span className="lp-eyebrow is-amber lp-reveal">Orchestrators and agents</span>
          <h2 id="lp-crew-title" className="lp-h2 lp-reveal">
            One orchestrator per project. As many agents as you need.
          </h2>
          <p className="lp-body lp-reveal">
            Armada launches; it does not orchestrate. The agent you work with drives sandboxes through Armada's MCP
            server: it launches them, prompts them, waits for each turn and reads what happened. Each agent works in a
            sandbox of its own and pushes its branch as you.
          </p>
          <dl className="lp-roles lp-reveal">
            <div>
              <dt>
                <i className="lp-role-mark is-coordinator" />
                Orchestrator
              </dt>
              <dd className="lp-mono">launch · send · wait · logs · stop</dd>
            </div>
            <div>
              <dt>
                <i className="lp-role-mark is-worker" />
                Agent
              </dt>
              <dd className="lp-mono">Claude Code · Codex</dd>
            </div>
            <div>
              <dt>
                <i className="lp-role-mark is-you" />
                You
              </dt>
              <dd>connect GitHub, store the keys, launch and follow every sandbox from the dashboard</dd>
            </div>
          </dl>
        </div>
        <div className="lp-split-media lp-crew lp-reveal">
          <CrewSky />
          <ul className="lp-crew-legend" aria-label="What flies">
            <li>
              <i style={{ background: "var(--frontier)" }} />
              prompt, answer
            </li>
            <li>
              <i style={{ background: "var(--accent)" }} />
              question for you
            </li>
            <li>
              <i style={{ background: "var(--done)" }} />
              turn finished, pull request
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
            Store each agent's key once, for you or for your org. Terminals hold only their Armada session, and each
            sandbox gets only the keys its agent needs.
          </p>
        </div>
        <div className="lp-facts">
          <div className="lp-fact lp-reveal">
            <span className="lp-fact-figure">{GITHUB_TOKEN_HOURS} hours</span>
            <p>
              Git and gh in a sandbox act as you through the GitHub App, with a token that lasts eight hours. The
              refresh token behind it stays sealed in Armada.
            </p>
          </div>
          <div className="lp-fact lp-reveal">
            <span className="lp-fact-figure">0 keys</span>
            <p>
              No stored key goes into a golden: a launch hands its agent's keys to the sandbox only. A GitHub token in a
              golden's home folders, /tmp or Git history stops its snapshot.
            </p>
          </div>
          <div className="lp-fact lp-reveal">
            <span className="lp-fact-figure is-mono">{CIPHER}</span>
            <p>
              Each stored key is sealed under Armada's encryption key. It goes in through stdin or a file, never an
              argument, and no page or command shows it again: they list kinds and dates.
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
          Install, sign in, launch. Before the first launch, store your agent's key and build a golden: the setup guide
          walks through both.
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
          <a href={SETUP_GUIDE} className="lp-button is-lime is-lg">
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
