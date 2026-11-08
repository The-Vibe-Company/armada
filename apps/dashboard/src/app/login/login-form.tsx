"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/action-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { type OAuthProvider, PROVIDER_LABELS } from "@/lib/auth-config";
import { type LoginState, sendLoginEmail, signInWithProvider, verifyLoginCode } from "./actions";

type Props = { next: string; providers: OAuthProvider[]; initialError: string | undefined };

export function LoginForm({ next, providers, initialError }: Props) {
  const [sent, sendAction] = useActionState<LoginState, FormData>(sendLoginEmail, { step: "email" });
  const [verified, verifyAction] = useActionState<LoginState, FormData>(verifyLoginCode, { step: "code" });

  const step = sent.step;
  const email = sent.email ?? "";
  const error = (step === "code" ? verified.error : sent.error) ?? (step === "email" ? initialError : undefined);

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {step === "email" ? (
        <form action={sendAction} className="space-y-3">
          <input type="hidden" name="next" value={next} />
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" placeholder="you@company.com" required />
          </div>
          <SubmitButton className="w-full">Email me a sign-in link</SubmitButton>
        </form>
      ) : (
        <form action={verifyAction} className="space-y-3">
          <input type="hidden" name="next" value={next} />
          <input type="hidden" name="email" value={email} />
          <p className="text-sm text-muted-foreground">
            We sent a link and a code to <strong className="text-foreground">{email}</strong>. Open the link, or enter
            the code here.
          </p>
          <div className="space-y-2">
            <Label htmlFor="code">Code</Label>
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              required
            />
          </div>
          <SubmitButton className="w-full">Sign in</SubmitButton>
        </form>
      )}

      {providers.length > 0 && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Separator className="flex-1" /> or <Separator className="flex-1" />
          </div>
          <form action={signInWithProvider} className="grid gap-2">
            <input type="hidden" name="next" value={next} />
            {providers.map((provider) => (
              <SubmitButton key={provider} variant="outline" name="provider" value={provider}>
                Continue with {PROVIDER_LABELS[provider]}
              </SubmitButton>
            ))}
          </form>
        </>
      )}
    </div>
  );
}
