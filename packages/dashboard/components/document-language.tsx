"use client";

import { useEffect } from "react";
import type { Language } from "@/lib/i18n";

/** Keeps `<html lang>` on the viewer's language after a move inside the app (DocumentLanguage). */
export function LanguageSync({ lang }: { lang: Language }) {
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return null;
}
