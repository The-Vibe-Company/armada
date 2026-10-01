"use client";

// Creates an organization API key and shows it once, in a card with a button
// to copy it: Armada keeps only its hash, so a key not copied now is lost.
import { useActionState } from "react";
import { type ApiKeyState, createApiKey } from "@/app/auth-actions";
import { CopyLink } from "@/components/CopyLink";
import { type Language, STRINGS } from "@/lib/i18n";
import { Button, Card, CardHead, Form, Input, Notice } from "./page";
import { Dot } from "./ui";

export function ApiKeyForm({ lang }: { lang: Language }) {
  const t = STRINGS[lang].org;
  const [state, action, pending] = useActionState<ApiKeyState, FormData>(createApiKey, null);
  return (
    <>
      {state && "key" in state && (
        <Card className="ui-secret">
          <CardHead icon={<Dot color="var(--done)" />} label={t.apiKeyCreated(state.name)} color="var(--text)" />
          <code className="mono ui-secret-value" role="status">
            {state.key}
          </code>
          <span>
            <CopyLink url={state.key} label={t.copyKey} done={t.copied} />
          </span>
        </Card>
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
