"use client";

import { useActionState } from "react";
import { execSandbox } from "@/app/actions/sandboxes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SandboxCommand({ sandboxId }: { sandboxId: string }) {
  const [state, action, pending] = useActionState(execSandbox, null);
  return (
    <form action={action} className="space-y-2 text-xs">
      <h2 className="font-medium text-muted-foreground">Run a command</h2>
      <input type="hidden" name="sandbox" value={sandboxId} />
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-muted-foreground">
          $
        </span>
        <Input
          name="command"
          aria-label="Run a command"
          placeholder="git status"
          required
          disabled={pending}
          className="h-9 min-w-0 font-mono text-xs"
        />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? "Running…" : "Run"}
        </Button>
      </div>
      <p className="text-muted-foreground">Runs beside the agent, in the same sandbox.</p>
      {state && (
        <pre
          role={state.ok ? "status" : "alert"}
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 font-mono"
        >
          {state.ok ? state.message : state.error}
        </pre>
      )}
    </form>
  );
}
