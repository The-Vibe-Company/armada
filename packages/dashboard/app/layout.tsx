import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { LANGUAGE_COOKIE, STRINGS } from "@/lib/i18n";
import { languageOf } from "@/lib/server";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const lang = languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value);
  return {
    title: STRINGS[lang].htmlTitle,
    description: "Armada: the live fleet of every registered project.",
    robots: { index: false, follow: false },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value);
  return (
    <html lang={lang} className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
