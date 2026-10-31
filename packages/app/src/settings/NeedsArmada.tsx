import { settingsHref } from "@/lib/route";

export const NEEDS_ARMADA = "Sign in to Armada in Settings";

/** The one line every place that needs the Armada web sign-in shows while signed out (THE-2071), linked to Settings › Account. */
export function NeedsArmada({ why }: { why: string }) {
  return (
    <p data-needs-armada className="m-0 text-small text-text-2">
      {why}{" "}
      <a
        href={settingsHref("account")}
        className="text-text underline decoration-line-strong underline-offset-2 hover:decoration-text"
      >
        {NEEDS_ARMADA}
      </a>
      .
    </p>
  );
}
