"use client";

import { createContext, type ReactNode, useState } from "react";
import { LaunchChip } from "@/components/launch-composer";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
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
  const [query, setQuery] = useState("");
  const typed = launchRepositoryInput(query);
  const newRepository = typed && !choices.some(([repository]) => repository === typed) ? typed : null;
  const select = (repository: string) => {
    onChange(repository);
    setOpen(false);
    setQuery("");
  };
  if (disabled) return <span className="break-all">{current || "No repository"}</span>;
  return (
    <LaunchChip
      title="Repository"
      className="h-auto py-1 text-lg font-semibold tracking-tight sm:text-xl"
      label={current || "No repository"}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Command>
        <CommandInput placeholder="Search or type owner/repo" value={query} onValueChange={setQuery} />
        <CommandList>
          {!newRepository && <CommandEmpty>No matching repositories.</CommandEmpty>}
          <CommandItem value="No repository" onSelect={() => select("")}>
            No repository
          </CommandItem>
          {choices.map(([repository, count]) => (
            <CommandItem key={repository} value={repository} onSelect={() => select(repository)}>
              <span className="min-w-0 flex-1 break-all">{repository}</span>
              <span className="text-xs text-muted-foreground">
                {count} ready {count === 1 ? "snapshot" : "snapshots"}
              </span>
            </CommandItem>
          ))}
          {newRepository && (
            <CommandItem forceMount value={newRepository} onSelect={() => select(newRepository)}>
              Use {newRepository}
            </CommandItem>
          )}
        </CommandList>
      </Command>
      {query && !typed && <p className="px-2 text-xs text-muted-foreground">Enter a repository as owner/repo.</p>}
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
