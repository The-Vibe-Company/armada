import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { cliOutcome } from "@/lib/github-cli";

export const metadata: Metadata = { title: "GitHub for the Armada CLI" };
export const dynamic = "force-dynamic";

const MESSAGES = {
  connected: {
    title: "GitHub is connected",
    text: "The Armada CLI can use your GitHub account now. Close this tab and go back to your terminal.",
  },
  denied: {
    title: "GitHub sign-in was cancelled",
    text: "Nothing was connected. Run the command again in your terminal when you are ready.",
  },
  failed: {
    title: "GitHub sign-in could not be completed",
    text: "The sign-in expired, was cancelled or was already used. Run the command again in your terminal.",
  },
} as const;

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** The end of the CLI's GitHub sign-in. Only a fixed outcome is read from the URL; nothing else is shown. */
export default async function GitHubCliPage({ searchParams }: Props) {
  const outcome = cliOutcome((await searchParams).result);
  const message = MESSAGES[outcome];
  const ok = outcome === "connected";
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4 rounded-xl border bg-card p-6 shadow-xs" data-cli-github={outcome}>
        <div className="flex items-center gap-2 font-semibold">
          <BrandMark />
          Armada
        </div>
        <div role={ok ? "status" : "alert"} className="flex gap-3">
          {ok ? (
            <CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-success" />
          ) : (
            <CircleAlertIcon className="mt-0.5 size-5 shrink-0 text-destructive" />
          )}
          <div className="space-y-1">
            <h1 className="font-medium">{message.title}</h1>
            <p className="text-sm text-muted-foreground">{message.text}</p>
          </div>
        </div>
      </div>
    </main>
  );
}
