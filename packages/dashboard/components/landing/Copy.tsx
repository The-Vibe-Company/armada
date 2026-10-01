"use client";

// A command to copy (THE-887): the whole row is the button, and its icon
// cross-fades to a check (better-ui: scale 0.25 to 1, blur 4px to 0).
import { useEffect, useRef, useState } from "react";

export function CopyCommand({ command, note, size = "md" }: { command: string; note?: string; size?: "md" | "lg" }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // No clipboard (an insecure page, a refusal): the command stays on screen to select.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button
      type="button"
      className={`lp-copy is-${size}`}
      onClick={copy}
      data-copied={copied || undefined}
      aria-label={copied ? `Copied: ${command}` : `Copy: ${command}`}
    >
      <span className="lp-copy-text">
        <span className="lp-copy-command">
          <span className="lp-prompt" aria-hidden>
            $
          </span>
          {command}
        </span>
        {note && <span className="lp-copy-note">{note}</span>}
      </span>
      <span className="lp-copy-icon" aria-hidden>
        <svg viewBox="0 0 16 16" className="is-copy" aria-hidden>
          <rect x="5.5" y="5.5" width="8" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
        <svg viewBox="0 0 16 16" className="is-done" aria-hidden>
          <path
            d="M3.5 8.5l3 3 6-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </button>
  );
}
