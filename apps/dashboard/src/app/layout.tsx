import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { geist, geistMono } from "./landing/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Armada", template: "%s · Armada" },
  description: "Launch Claude Code, Codex and OpenCode agents into Boat, Modal or Docker sandboxes.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geist.variable} ${geistMono.variable}`}>
      <body className="min-h-dvh font-sans">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
