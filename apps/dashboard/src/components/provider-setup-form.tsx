"use client";

import type { SandboxProviderId } from "@armada/core";
import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { useFormStatus } from "react-dom";
import { connectProvider } from "@/app/actions/provider-setup";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SETUP_PROVIDER_INFO, SETUP_PROVIDERS } from "@/lib/provider-setup";
import { cn } from "@/lib/utils";

/**
 * The admin's provider choice and its secret fields. Only the chosen provider's fields are in the form, so switching
 * from Boat to Modal never sends the other's value. Fields are password inputs and are never filled back in.
 */
export function ProviderSetupForm({ orgId }: { orgId: string }) {
  const [provider, setProvider] = useState<SandboxProviderId>("boat");
  const info = SETUP_PROVIDER_INFO[provider];
  return (
    <ActionForm action={connectProvider} resetOnSuccess className="space-y-6" key={orgId}>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="provider" value={provider} />
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Provider</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {SETUP_PROVIDERS.map((item) => {
            const option = SETUP_PROVIDER_INFO[item];
            const checked = item === provider;
            return (
              <label
                key={item}
                data-provider-option={item}
                className={cn(
                  "relative flex cursor-pointer flex-col gap-1 rounded-lg border bg-background p-4 transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
                  checked ? "border-foreground shadow-xs" : "hover:bg-accent/50",
                )}
              >
                <input
                  type="radio"
                  name="provider_choice"
                  value={item}
                  checked={checked}
                  onChange={() => setProvider(item)}
                  className="sr-only"
                />
                <span className="flex items-center justify-between gap-2 text-sm font-semibold">
                  {option.label}
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-5 items-center justify-center rounded-full border",
                      checked ? "border-foreground bg-foreground text-background" : "border-input",
                    )}
                  >
                    {checked && <CheckIcon className="size-3" />}
                  </span>
                </span>
                <span className="text-sm text-muted-foreground">{option.summary}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {provider === "boat" ? (
        <div className="space-y-2">
          <Label htmlFor="boat-key">Boat API key</Label>
          <Input
            id="boat-key"
            name="boat_key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            aria-describedby="boat-key-help"
          />
          <p id="boat-key-help" className="text-xs">
            <DocsLink provider="boat" />
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="modal-token-id">Token ID</Label>
              <Input
                id="modal-token-id"
                name="modal_token_id"
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                placeholder="ak-…"
                aria-describedby="modal-token-help"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="modal-token-secret">Token secret</Label>
              <Input
                id="modal-token-secret"
                name="modal_token_secret"
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                placeholder="as-…"
                aria-describedby="modal-token-help"
              />
            </div>
          </div>
          <p id="modal-token-help" className="text-xs">
            <DocsLink provider="modal" />
          </p>
        </div>
      )}

      <ConnectButton label={info.label} />
    </ActionForm>
  );
}

function DocsLink({ provider }: { provider: SandboxProviderId }) {
  const info = SETUP_PROVIDER_INFO[provider];
  return (
    <a
      href={info.docs}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4"
    >
      {info.docsLabel}
      <ExternalLinkIcon className="size-3" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function ConnectButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <>
      <SubmitButton>{pending ? `Checking with ${label}…` : `Connect ${label}`}</SubmitButton>
      <p role="status" className="sr-only">
        {pending ? `Checking the credentials with ${label}…` : ""}
      </p>
    </>
  );
}
