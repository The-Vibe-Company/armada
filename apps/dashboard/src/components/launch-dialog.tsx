"use client";

import type { Harness } from "@armada/core";
import { RocketIcon } from "lucide-react";
import { useState } from "react";
import { launchFromGolden } from "@/app/actions/sandboxes";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { type ModelCatalog, ModelFields } from "@/components/model-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

const HARNESS_LABELS: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" };

/** Launches an agent from a golden: harness, model, reasoning effort and an optional first prompt. */
export function LaunchDialog({
  golden,
  provider,
  orgId,
  catalog,
}: {
  golden: string;
  /** The golden's sandbox provider: the same name may exist on another one. */
  provider: string;
  orgId: string;
  catalog: ModelCatalog;
}) {
  const [harness, setHarness] = useState<Harness>("claude");
  const id = `launch-${golden}`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Launch from ${golden}`}>
          <RocketIcon /> Launch
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Launch from {golden}</DialogTitle>
          <DialogDescription>
            The model and reasoning effort apply to the first prompt and to every later message.
          </DialogDescription>
        </DialogHeader>
        <ActionForm action={launchFromGolden} className="space-y-3">
          <input type="hidden" name="golden" value={golden} />
          <input type="hidden" name="provider" value={provider} />
          <input type="hidden" name="org" value={orgId} />
          <div className="space-y-2">
            <Label htmlFor={`${id}-harness`}>Agent</Label>
            <NativeSelect
              id={`${id}-harness`}
              name="harness"
              value={harness}
              onChange={(event) => setHarness(event.target.value as Harness)}
            >
              {(Object.keys(catalog) as Harness[]).map((value) => (
                <option key={value} value={value}>
                  {HARNESS_LABELS[value]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <ModelFields key={harness} idPrefix={id} harness={harness} catalog={catalog} />
          <div className="space-y-2">
            <Label htmlFor={`${id}-prompt`}>First prompt</Label>
            <Textarea
              id={`${id}-prompt`}
              name="prompt"
              rows={4}
              placeholder="Optional. Leave empty for a sandbox that waits for the first message."
            />
          </div>
          <SubmitButton>Launch</SubmitButton>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
