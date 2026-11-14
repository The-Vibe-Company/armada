"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { importTicketGraph } from "./ticket-graph-actions";
export function TicketGraphForm({ orgId, id }: { orgId: string; id: string }) {
  return (
    <details className="rounded-lg border p-5">
      <summary>Developer fallback: import ticket JSON</summary>
      <ActionForm
        action={importTicketGraph}
        className="space-y-3 mt-4"
        focusError
        footer={<SubmitButton>Save plan</SubmitButton>}
      >
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="id" value={id} />
        <Label htmlFor="ticket-graph">Structured ticket file contents (JSON)</Label>
        <Textarea id="ticket-graph" name="graph" required maxLength={100000} rows={8} />
        <p className="text-sm text-muted-foreground">
          Normally the brief publishes through the recorded server tool. This developer fallback uses the same tool.
          Paste a graph with briefRevision and ordered tickets. Each ticket needs id, outcome, criteria (use and proof),
          exclusions and dependencies (local ticket IDs). No checkout file or GitHub issue is created.
        </p>
      </ActionForm>
    </details>
  );
}
