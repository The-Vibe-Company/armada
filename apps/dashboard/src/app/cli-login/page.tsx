import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { decideCliLogin, inspectCliLogin } from "./actions";

export const metadata: Metadata = { title: "Authorize the Armada CLI", referrer: "no-referrer" };

export default async function CliLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; result?: string }>;
}) {
  const { id, result } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user && typeof id === "string")
    redirect(`/login?next=${encodeURIComponent(`/cli-login?id=${encodeURIComponent(id)}`)}`);
  const login = user && typeof id === "string" ? await inspectCliLogin(id) : null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-8">
      <section className="flex w-full max-w-[360px] flex-col gap-6">
        <BrandMark className="size-10 rounded-[10px] [&_svg]:size-6" />
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]">Authorize the Armada CLI</h1>
        {login && user && id ? (
          <>
            <p className="break-words text-sm text-muted-foreground">
              <strong>{login.hostname}</strong> is requesting access as <strong>{user.email ?? user.id}</strong>.
              Authorize only if this code matches the one in your terminal.
            </p>
            <p className="font-mono text-xl tracking-widest">{login.user_code}</p>
            <form action={decideCliLogin.bind(null, id, login.user_code, user.id)} className="flex gap-3">
              <Button type="submit" name="decision" value="deny" variant="outline">
                Deny
              </Button>
              <Button type="submit" name="decision" value="authorize">
                Authorize
              </Button>
            </form>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {result === "authorize"
              ? "CLI authorized. Return to your terminal."
              : result === "deny"
                ? "CLI sign-in denied."
                : "This request is unavailable. Run armada login to start again."}
          </p>
        )}
      </section>
    </main>
  );
}
