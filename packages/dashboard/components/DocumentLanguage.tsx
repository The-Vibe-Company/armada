import { cookies } from "next/headers";
import { LANGUAGE_COOKIE } from "@/lib/i18n";
import { languageOf } from "@/lib/server";
import { LanguageSync } from "./document-language";

// The root layout is static, for the landing (THE-887): it cannot read the
// language cookie, so it says `lang="en"`. Each page that reads the cookie
// corrects `<html lang>` here (document-language.tsx).
export async function DocumentLanguage() {
  return <LanguageSync lang={languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)} />;
}
