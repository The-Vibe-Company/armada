// Written by `bun run fonts` (scripts/fonts.ts) from the `geist` package: do not edit.
// Each Latin cut is preloaded on every page; each full font is listed first in
// --font-sans and --font-mono (app/globals.css) and loads only for a character in its range.
import localFont from "next/font/local";

export const geist = localFont({
  src: "./geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  declarations: [{ prop: "unicode-range", value: "U+0-17F, U+2000-206F, U+20AC, U+2122, U+2190-21FF, U+2212" }],
});

export const geistFull = localFont({
  src: "./geist.woff2",
  variable: "--font-geist-sans-full",
  weight: "100 900",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+18F, U+192, U+1A0-1A1, U+1AF-1B0, U+1CD-1CE, U+1E4-1E9, U+218-21B, U+237, U+259, U+2B9, U+2BC, U+2C6-2C8, U+2D8-2DD, U+300-304, U+306-30C, U+312, U+31B, U+323, U+326-328, U+335-338, U+39B, U+3A9, U+3BB-3BC, U+3C0, U+3C9, U+400-45F, U+462-463, U+46A-46B, U+472-475, U+490-493, U+496-497, U+49A-49B, U+4A2-4A3, U+4AE-4B3, U+4B6-4B7, U+4BA-4BB, U+4C0, U+4CF, U+4D8-4D9, U+4E2-4E3, U+4E8-4E9, U+4EE-4EF, U+E3F, U+1E20-1E21, U+1E80-1E85, U+1E9E, U+1EA0-1EF9, U+2070, U+2074-2079, U+2080-2089, U+20AA, U+20B1, U+20B4, U+20B9, U+20BD, U+2116-2117, U+2153-2155, U+215B-215E, U+2202, U+2206, U+220F, U+2211, U+221A, U+221E, U+222B, U+2236, U+2248, U+2260, U+2264-2265, U+2460-2468, U+24EA, U+24FF, U+25B2-25B3, U+25B6-25B7, U+25BC-25BD, U+25C0-25C1, U+25CA-25CC, U+25CF, U+2639-263A, U+2776-277E, U+3003, U+301C, U+A78B-A78C, U+F8FF, U+FB01-FB02",
    },
  ],
});

export const geistMono = localFont({
  src: "./geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
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

export const geistMonoFull = localFont({
  src: "./geist-mono.woff2",
  variable: "--font-geist-mono-full",
  weight: "100 900",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+18F, U+192, U+1A0-1A1, U+1AF-1B0, U+1CD-1CE, U+1E4-1E9, U+218-21B, U+237, U+259, U+2B9, U+2BC, U+2C6-2C8, U+2D8-2DD, U+300-304, U+306-30C, U+312, U+31B, U+323, U+326-328, U+335-338, U+39B, U+3A9, U+3BB-3BC, U+3C0, U+400-45F, U+462-463, U+46A-46B, U+472-475, U+490-493, U+496-497, U+49A-49B, U+4A2-4A3, U+4AE-4B3, U+4B6-4B7, U+4BA-4BB, U+4C0, U+4CF, U+4D8-4D9, U+4E2-4E3, U+4E8-4E9, U+4EE-4EF, U+E3F, U+1E20-1E21, U+1E80-1E85, U+1E9E, U+1EA0-1EF9, U+2070, U+2074-2079, U+2080-2089, U+20AA, U+20B1, U+20B4, U+20B9, U+20BD, U+2107, U+2116-2117, U+2153-2155, U+215B-215E, U+2202, U+2206, U+220F, U+2211, U+221A, U+221E, U+222B, U+2236, U+2248, U+2260, U+2264-2265, U+2326-2327, U+232B, U+23CE, U+240B-240C, U+2423, U+2460-2468, U+24EA, U+24FF-259F, U+25B2-25B3, U+25B6-25B7, U+25BC-25BD, U+25C0-25C1, U+25CA-25CC, U+25CF, U+2776-277E, U+3003, U+301C, U+A78B-A78C, U+F8FF",
    },
  ],
});
