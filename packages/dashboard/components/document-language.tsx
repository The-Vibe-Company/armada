"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { Language } from "@/lib/i18n";

const never = () => () => {};

/**
 * Sets `<html lang>` to the viewer's language: an inline script in the
 * server's HTML, so it is right before anything is read, and an effect after a
 * move inside the app, where an inline script would not run.
 */
export function LanguageSync({ lang }: { lang: Language }) {
  // True while the server renders and the page hydrates, false once in the browser.
  const fromServer = useSyncExternalStore(
    never,
    () => false,
    () => true,
  );
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return fromServer ? (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed statement; `lang` is one of the known languages.
    <script dangerouslySetInnerHTML={{ __html: `document.documentElement.lang=${JSON.stringify(lang)}` }} />
  ) : null;
}
