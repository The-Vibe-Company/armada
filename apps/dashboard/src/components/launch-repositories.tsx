"use client";

import { createContext, type ReactNode, useState } from "react";
import { GitHubRepoPickerContent } from "@/components/github-repo-picker";
import { LaunchChip } from "@/components/launch-composer";
import { Button } from "@/components/ui/button";
import { repoKey } from "@/lib/github-repos";
import type { LaunchStartTarget } from "@/lib/launch-picker";
import { launchRepositoryInput } from "@/lib/launch-repositories";

export const LaunchRepositoryContext = createContext<{
  headline: ReactNode;
  withoutRepository: ReactNode;
  repository: string;
  building: boolean;
  hold?: ReactNode;
  fromLabel?: string | undefined;
  fromOpen: boolean;
  setFromOpen: (open: boolean) => void;
  otherStarts: readonly LaunchStartTarget[];
  othersOpen: boolean;
  setOthersOpen: (open: boolean) => void;
} | null>(null);

export function RepositoryPicker({
  current,
  choices,
  onChange,
  disabled,
}: {
  current: string;
  choices: readonly (readonly [string, number])[];
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const select = (repository: string) => {
    onChange(repository ? (launchRepositoryInput(repository) ?? repoKey(repository)) : "");
    setOpen(false);
  };
  if (disabled) return <span className="break-all">{current || "No repository"}</span>;
  return (
    <LaunchChip
      title="Repository"
      className="h-auto py-1 text-lg font-semibold tracking-tight sm:text-xl"
      label={current || "No repository"}
      open={open}
      onOpenChange={setOpen}
    >
      <GitHubRepoPickerContent
        open={open}
        selected={current ? [current] : []}
        allowEmptySelection
        snapshotChoices={choices}
        onSelect={select}
      />
    </LaunchChip>
  );
}

export function WithoutRepository({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={onClick}>
      or start without a repository
    </Button>
  );
}
