"use client";

import { useState, useTransition } from "react";
import { createApiKey } from "@/app/actions/api-keys";
import { CreateDialog } from "@/components/create-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ApiKeyCreateDialog({ orgs }: { orgs: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Awaited<ReturnType<typeof createApiKey>>>();
  const [copyStatus, setCopyStatus] = useState("");
  const issued = result?.ok === true;
  const snippet = issued ? `export ARMADA_URL='${result.origin}' ARMADA_TOKEN='${result.token}'` : "";

  function close(next: boolean) {
    if (pending) return;
    setOpen(next);
    setResult(undefined);
    setCopyStatus("");
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus("Copied.");
    } catch {
      setCopyStatus("Clipboard unavailable. Select the text and copy it manually.");
    }
  }

  return (
    <CreateDialog
      triggerAttrs={{ id: "api-key-create" }}
      label="Create API key"
      title={issued ? "Copy your API key" : "Create API key"}
      description={issued ? "Save the key securely before closing this dialog. It is shown only once." : undefined}
      open={open}
      onOpenChange={close}
      dismissible={!issued && !pending}
      showCloseButton={!issued && !pending}
    >
      {issued ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Input readOnly aria-label="API key" value={result.token} className="font-mono" />
            <Button type="button" variant="outline" onClick={() => void copy(result.token)}>
              Copy key
            </Button>
          </div>
          <div className="space-y-2">
            <pre className="overflow-x-auto rounded-md border bg-muted p-3 text-sm">{snippet}</pre>
            <Button type="button" variant="outline" onClick={() => void copy(snippet)}>
              Copy shell snippet
            </Button>
          </div>
          <p role="status" className="text-sm text-muted-foreground">
            {copyStatus}
          </p>
          <Button type="button" onClick={() => close(false)}>
            Done
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4"
          aria-busy={pending}
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            const form = new FormData(event.currentTarget);
            startTransition(async () => {
              try {
                setResult(await createApiKey(form));
              } catch {
                setResult({ ok: false, error: "Could not confirm creation. Check the key list before trying again." });
              }
            });
          }}
        >
          <label className="grid gap-2 text-sm font-medium" htmlFor="api-key-name">
            Name
            <Input id="api-key-name" name="name" required maxLength={80} disabled={pending} />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            Organization
            <select className="h-9 rounded-md border bg-background px-3" name="org" required disabled={pending}>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-medium">
            Expires
            <select
              className="h-9 rounded-md border bg-background px-3"
              name="expires"
              defaultValue="30d"
              disabled={pending}
            >
              <option value="30d">30 days</option>
              <option value="90d">90 days</option>
              <option value="1y">1 year</option>
              <option value="never">Never</option>
            </select>
          </label>
          {result && (
            <p role="alert" className="text-sm text-destructive">
              {result.error}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create API key"}
          </Button>
        </form>
      )}
    </CreateDialog>
  );
}
