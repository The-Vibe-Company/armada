// Geist and Geist Mono for the landing (THE-889), restored by #564: the Latin
// cuts armada-v1-final preloaded on every page (its app/fonts, cut by `bun run
// fonts` from the `geist` package, SIL Open Font License: fonts/LICENSE.txt).
// `optional`, as in v1: a page that would paint before they arrive keeps its
// fallback rather than move. Only the landing loads them.
import localFont from "next/font/local";

export const geist = localFont({
  src: "./fonts/geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "optional",
  declarations: [{ prop: "unicode-range", value: "U+0-17F, U+2000-206F, U+20AC, U+2122, U+2190-21FF, U+2212" }],
});

export const geistMono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "optional",
  adjustFontFallback: false,
  fallback: [
    "ui-monospace",
    "SFMono-Regular",
    "Roboto Mono",
    "Menlo",
    "Monaco",
    "Liberation Mono",
    "DejaVu Sans Mono",
    "Courier New",
    "monospace",
  ],
  declarations: [{ prop: "unicode-range", value: "U+0-17F, U+2000-206F, U+20AC, U+2122, U+2190-21FF, U+2212" }],
});
