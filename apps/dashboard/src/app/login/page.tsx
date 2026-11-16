import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { enabledProviders } from "@/lib/auth-config";
import { GITHUB_RESULT_MESSAGES } from "@/lib/github";
import { INVITATION_ACCEPT_PATH } from "@/lib/invitations";
import { safeNextPath } from "@/lib/routes";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  callback: "That sign-in link is invalid or has expired. Request a new one.",
  provider: "That sign-in method is not available.",
  github_install: GITHUB_RESULT_MESSAGES.sign_in.text,
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const providers = enabledProviders(process.env.NEXT_PUBLIC_AUTH_PROVIDERS);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-8">
      <div className="flex w-full max-w-[360px] flex-col gap-6">
        <header className="flex flex-col gap-4">
          <BrandMark className="size-10 rounded-[10px] [&_svg]:size-6" />
          <div className="space-y-1.5">
            <h1 className="text-[22px] font-semibold tracking-[-0.015em]">Sign in to Armada</h1>
            <p className="text-sm leading-normal text-muted-foreground">
              {next === INVITATION_ACCEPT_PATH
                ? "Use the address your invitation was sent to. We email you a sign-in link and a code."
                : "Run Claude Code and Codex in sandboxes built from your repositories."}
            </p>
          </div>
        </header>
        <LoginForm next={next} providers={providers} initialError={error} />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Prefer the terminal? <code>npm i -g @the-vibe-company/armada &amp;&amp; armada login</code>
        </p>
      </div>
    </main>
  );
}
