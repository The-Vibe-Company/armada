"use client";

// Creates an organization API key and shows it once, with a button to copy
// it: Armada keeps only its hash, so a key not copied now is lost.
import { useActionState } from "react";
import { type ApiKeyState, createApiKey } from "@/app/auth-actions";
import { CopyLink } from "@/components/CopyLink";
import { type Language, STRINGS } from "@/lib/i18n";

export function ApiKeyForm({ lang }: { lang: Language }) {
  const t = STRINGS[lang].org;
  const [state, action, pending] = useActionState<ApiKeyState, FormData>(createApiKey, null);
  return (
    <>
      {state && "key" in state && (
        <div className="secret-once" role="status">
          <p className="login-notice">{t.apiKeyCreated(state.name)}</p>
          <code className="mono">{state.key}</code>
          <span className="row-actions">
            <CopyLink url={state.key} label={t.copyKey} done={t.copied} />
          </span>
        </div>
      )}
      {state && "error" in state && (
        <p className="login-error" role="alert">
          {t.errors[state.error]}
        </p>
      )}
      <form action={action} className="invite-form">
        <label className="sr-only" htmlFor="api-key-name">
          {t.apiKeyName}
        </label>
        <input id="api-key-name" name="name" required maxLength={32} placeholder={t.apiKeyName} autoComplete="off" />
        <button type="submit" className="btn is-primary" disabled={pending}>
          {t.createApiKey}
        </button>
      </form>
    </>
  );
}
