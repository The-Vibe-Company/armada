import localFont from "next/font/local";

// Geist Mono as geist/font/mono declares it, but not preloaded (THE-887): the
// landing's first paint is its sans headline, and a second 70 kB font fetched
// before it held its largest paint back. The dashboard's figures swap to it
// as soon as it arrives.
export const GeistMono = localFont({
  src: "../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  adjustFontFallback: false,
  preload: false,
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
  weight: "100 900",
});
