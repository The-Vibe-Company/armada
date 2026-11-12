"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { SubmitButton } from "@/components/action-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { type OAuthProvider, PROVIDER_LABELS } from "@/lib/auth-config";
import { type LoginState, sendLoginEmail, signInWithProvider, verifyLoginCode } from "./actions";

type Props = { next: string; providers: OAuthProvider[]; initialError: string | undefined };

export function LoginForm({ next, providers, initialError }: Props) {
  const [sent, sendAction] = useActionState<LoginState, FormData>(sendLoginEmail, { step: "email" });
  const [verified, verifyAction] = useActionState<LoginState, FormData>(verifyLoginCode, { step: "code" });

  const id = useId();
  const emailId = `${id}-email`;
  const codeId = `${id}-code`;
  const errorId = `${id}-error`;
  const codeHintId = `${id}-code-hint`;
  const emailInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (sent.step === "code") codeInput.current?.focus();
    else if (sent.error) emailInput.current?.focus();
  }, [sent]);

  useEffect(() => {
    if (verified.error) codeInput.current?.focus();
  }, [verified]);

  const step = sent.step;
  const email = sent.email ?? "";
  const fieldError = step === "code" ? verified.error : sent.error;
  const error = fieldError ?? (step === "email" ? initialError : undefined);

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription id={errorId}>{error}</AlertDescription>
        </Alert>
      )}

      {step === "email" ? (
        <form action={sendAction} className="space-y-3">
          <input type="hidden" name="next" value={next} />
          <div className="space-y-2">
            <Label htmlFor={emailId}>Email</Label>
            <Input
              ref={emailInput}
              id={emailId}
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              required
              aria-describedby={fieldError ? errorId : undefined}
            />
          </div>
          <SubmitButton className="w-full">Email me a sign-in link</SubmitButton>
        </form>
      ) : (
        <form action={verifyAction} className="space-y-3">
          <input type="hidden" name="next" value={next} />
          <input type="hidden" name="email" value={email} />
          <p id={codeHintId} className="text-sm text-muted-foreground">
            We sent a link and a code to <strong className="text-foreground">{email}</strong>. Open the link, or enter
            the code here.
          </p>
          <div className="space-y-2">
            <Label htmlFor={codeId}>Code</Label>
            <Input
              ref={codeInput}
              id={codeId}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-invalid={!!fieldError}
              aria-describedby={`${codeHintId}${fieldError ? ` ${errorId}` : ""}`}
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
