import { cookies } from "next/headers";
import { LANGUAGE_COOKIE } from "@/lib/i18n";
import { languageOf } from "@/lib/server";
import { LanguageSync } from "./document-language";

// The root layout is static, for the landing (THE-887): it cannot read the
// language cookie, so it says `lang="en"`. Each page that reads the cookie
// corrects `<html lang>` here: an inline script while the HTML is parsed, and
// an effect after a move inside the app.
export async function DocumentLanguage() {
  const lang = languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value);
  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed statement; `lang` is one of the known languages. */}
      <script dangerouslySetInnerHTML={{ __html: `document.documentElement.lang=${JSON.stringify(lang)}` }} />
      <LanguageSync lang={lang} />
    </>
  );
}
