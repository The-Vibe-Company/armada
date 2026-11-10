import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <BrandMark className="mx-auto mb-2 size-10 rounded-xl [&_svg]:size-5" />
          <CardTitle className="text-xl">Sign in to Armada</CardTitle>
          <CardDescription>
            {next === INVITATION_ACCEPT_PATH
              ? "Use the address your invitation was sent to. We email you a sign-in link and a code."
              : "We email you a sign-in link and a code. No password."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm next={next} providers={providers} initialError={error} />
        </CardContent>
      </Card>
    </main>
  );
}
