"use client";

import { ActionForm, SubmitButton } from "@/components/action-form";
import { CreateDialog } from "@/components/create-dialog";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { addObjectiveMessage, createObjective } from "./actions";

export function CreateObjectiveDialog({ orgId, repositories }: { orgId: string; repositories: string[] }) {
  return (
    <CreateDialog
      label="New objective"
      title="New objective"
      description="One request, one repository. Your private thread is saved; no engine or worker starts here."
    >
      <ActionForm
        action={createObjective}
        className="space-y-4"
        focusError
        footer={<SubmitButton disabled={!repositories.length}>Create objective</SubmitButton>}
      >
        <input type="hidden" name="org" value={orgId} />
        <div className="space-y-2">
          <Label htmlFor="objective-repository">Repository</Label>
          <NativeSelect
            name="repository"
            id="objective-repository"
            required
            disabled={!repositories.length}
            defaultValue=""
          >
            <option value="" disabled>
              Choose a connected repository
            </option>
            {repositories.map((repository) => (
              <option key={repository} value={repository}>
                {repository}
              </option>
            ))}
          </NativeSelect>
        </div>
        {!repositories.length && (
          <p className="text-sm text-muted-foreground">
            Connect a repository through a snapshot first, then return here.
          </p>
        )}
        <div className="space-y-2">
          <Label htmlFor="objective-request">What would you like to accomplish?</Label>
          <Textarea id="objective-request" name="request" required maxLength={20000} rows={5} />
        </div>
      </ActionForm>
    </CreateDialog>
  );
}

export function ObjectiveMessageForm({ orgId, id }: { orgId: string; id: string }) {
  return (
    <ActionForm
      action={addObjectiveMessage}
      className="space-y-3"
      resetOnSuccess
      focusError
      footer={<SubmitButton>Save message</SubmitButton>}
    >
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="id" value={id} />
      <Label htmlFor="objective-message">Add to this thread</Label>
      <Textarea name="body" id="objective-message" required maxLength={20000} rows={4} />
      <p className="text-sm text-muted-foreground">
        Messages are saved privately. Otto does not execute requests in this slice.
      </p>
    </ActionForm>
  );
}
