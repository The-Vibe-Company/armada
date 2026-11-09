import Link from "next/link";
import { COMPANY, DOCS, RELEASES, REPOSITORY, VERSION } from "./content";
import { GitHubIcon } from "./Hero";
import { Mark } from "./Mark";

// The landing's footer (THE-887, #564).

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
