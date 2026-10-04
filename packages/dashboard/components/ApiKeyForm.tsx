"use client";

// Creates an organization API key and shows it once, in a card with a button
// to copy it: Armada keeps only its hash, so a key not copied now is lost.
import { useActionState } from "react";
import { type ApiKeyState, createApiKey } from "@/app/auth-actions";
import { CopyLink } from "@/components/CopyLink";
import { type Language, STRINGS } from "@/lib/i18n";
import { Button, Form, Input, Notice } from "./page";

export function ApiKeyForm({ lang }: { lang: Language }) {
  const t = STRINGS[lang].org;
  const [state, action, pending] = useActionState<ApiKeyState, FormData>(createApiKey, null);
  return (
    <>
      {state && "key" in state && (
        <div className="ui-secret" role="status">
          <p className="ui-secret-title">{t.apiKeyCreated(state.name)}</p>
          <code className="mono ui-secret-value">{state.key}</code>
          <span>
            <CopyLink url={state.key} label={t.copyKey} done={t.copied} />
          </span>
        </div>
      )}
      {state && "error" in state && <Notice tone="critical">{t.errors[state.error]}</Notice>}
      <Form action={action} grow>
        <label className="sr-only" htmlFor="api-key-name">
          {t.apiKeyName}
        </label>
        <Input id="api-key-name" name="name" required maxLength={32} placeholder={t.apiKeyName} autoComplete="off" />
        <Button tone="primary" disabled={pending}>
          {t.createApiKey}
        </Button>
      </Form>
    </>
  );
}
