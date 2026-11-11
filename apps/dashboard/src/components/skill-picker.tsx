"use client";

import type { SkillCatalogItem, SkillCatalogSource } from "@armada/core";
import { CheckIcon, ChevronLeftIcon, LoaderCircleIcon, PlusIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { listSkillCatalog, listSkillVersions } from "@/app/actions/skill-catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SKILL_PIN_HINT, skillPinProblem } from "@/lib/skills";

interface Props {
  orgId: string;
  value: string[];
  onChange: (pins: string[]) => void;
  disabled?: boolean;
}

function Visibility({ source }: { source: SkillCatalogSource }) {
  return (
    <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
      {source === "public" ? "Public" : "Private"}
    </Badge>
  );
}

/** Lazy, metadata-only browsing. Exact pins remain usable when catalog discovery is unavailable. */
export function SkillPicker({ orgId, value, onChange, disabled = false }: Props) {
  const id = useId();
  const { pending } = useFormStatus();
  const locked = disabled || pending;
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<SkillCatalogSource>("private");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SkillCatalogItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentialIssue, setCredentialIssue] = useState(false);
  const [chosen, setChosen] = useState<SkillCatalogItem | null>(null);
  const [versions, setVersions] = useState<string[]>([]);
  const [version, setVersion] = useState("");
  const [versionLoading, setVersionLoading] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, SkillCatalogItem>>({});
  const listRequest = useRef(0);
  const versionRequest = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const exactPinInput = useRef<HTMLInputElement>(null);
  const versionSelect = useRef<HTMLSelectElement>(null);
  const versionsBack = useRef<HTMLButtonElement>(null);

  const focusView = useCallback(() => {
    if (manual) exactPinInput.current?.focus();
    else if (!chosen) searchInput.current?.focus();
    else if (!versionLoading && versions.length && !versionSelect.current?.disabled) versionSelect.current?.focus();
    else versionsBack.current?.focus();
  }, [manual, chosen, versionLoading, versions.length]);

  useEffect(() => {
    if (open) focusView();
  }, [open, focusView]);

  const loadPage = useCallback(
    async (offset: number, request: number, activeSource: SkillCatalogSource) => {
      setLoading(true);
      setError(null);
      setCredentialIssue(false);
      try {
        const result = await listSkillCatalog({ org: orgId, source: activeSource, offset });
        if (request !== listRequest.current) return;
        if (!result.ok) {
          setError(result.error);
          setCredentialIssue(result.code === "missing_credential" || result.code === "credential_refused");
          return;
        }
        setItems((previous) => [
          ...new Map(
            (offset ? [...previous, ...result.page.items] : result.page.items).map((item) => [item.reference, item]),
          ).values(),
        ]);
        setNextOffset(result.page.nextOffset);
      } catch {
        if (request === listRequest.current) setError("Skills could not be loaded. Try again or enter an exact pin.");
      } finally {
        if (request === listRequest.current) setLoading(false);
      }
    },
    [orgId],
  );

  useEffect(() => {
    const request = ++listRequest.current;
    ++versionRequest.current;
    setItems([]);
    setNextOffset(null);
    setChosen(null);
    setVersionError(null);
    setPinError(null);
    if (open) void loadPage(0, request, source);
    return () => {
      ++listRequest.current;
      ++versionRequest.current;
    };
    // A source change starts a new bounded read; opening, not rendering the form, initiates discovery.
  }, [open, source, loadPage]);

  async function choose(item: SkillCatalogItem) {
    const request = ++versionRequest.current;
    setChosen(item);
    setVersionLoading(true);
    setVersionError(null);
    setPinError(null);
    setVersions([]);
    setVersion("");
    try {
      const result = await listSkillVersions({ org: orgId, source: item.visibility, reference: item.reference });
      if (request !== versionRequest.current) return;
      if (!result.ok) {
        setVersionError(result.error);
        return;
      }
      setVersions(result.versions);
      setVersion(
        result.versions.includes(item.versions[0] ?? "") ? (item.versions[0] ?? "") : (result.versions[0] ?? ""),
      );
      if (!result.versions.length)
        setVersionError("No published version is available. You can enter an exact pin instead.");
    } catch {
      if (request === versionRequest.current)
        setVersionError("Versions could not be loaded. You can enter an exact pin instead.");
    } finally {
      if (request === versionRequest.current) setVersionLoading(false);
    }
  }

  function add(exact: string, item?: SkillCatalogItem) {
    const problem = skillPinProblem([...value, exact]);
    if (problem) {
      setPinError(problem);
      return;
    }
    if (item) setNames((previous) => ({ ...previous, [exact]: item }));
    onChange([...value, exact]);
    setPin("");
    setPinError(null);
    setOpen(false);
  }

  return (
    <div className="space-y-2" data-launch-skills>
      {value.map((exact) => (
        <input key={exact} type="hidden" name="skills" value={exact} />
      ))}
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">Additional skills</p>
          <p className="text-xs text-muted-foreground">Installed alongside any configured defaults.</p>
        </div>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={locked}>
              <PlusIcon /> Add skills
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-[min(26rem,calc(100vw-3rem))] overflow-hidden p-0"
            aria-label="Choose additional skills"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              focusView();
            }}
          >
            <fieldset className="flex items-center gap-1 border-b p-2" aria-label="Skill source">
              {(
                [
                  ["private", "Workspace"],
                  ["public", "Public catalog"],
                ] as const
              ).map(([kind, label]) => (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant={source === kind ? "secondary" : "ghost"}
                  aria-pressed={source === kind}
                  disabled={locked}
                  onClick={() => {
                    ++versionRequest.current;
                    setChosen(null);
                    setSource(kind);
                    setQuery("");
                    setManual(false);
                    searchInput.current?.focus();
                  }}
                >
                  {label}
                </Button>
              ))}
            </fieldset>
            {!manual && !chosen && (
              <>
                <Command>
                  <CommandInput
                    ref={searchInput}
                    placeholder="Search skills"
                    value={query}
                    onValueChange={setQuery}
                    disabled={locked}
                  />
                  <CommandList className="max-h-60 overscroll-contain">
                    {!loading && !error && <CommandEmpty>No matching skills in the loaded results.</CommandEmpty>}
                    {items.map((item) => (
                      <CommandItem
                        key={item.reference}
                        value={item.reference}
                        keywords={[item.name, item.description]}
                        disabled={locked}
                        onSelect={() => void choose(item)}
                        className="items-start gap-2 px-3 py-3"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 break-words font-medium">{item.name}</span>
                            <Visibility source={item.visibility} />
                          </div>
                          <p className="line-clamp-2 text-xs leading-4 text-muted-foreground">{item.description}</p>
                          <p className="break-all font-mono text-[11px] text-muted-foreground">
                            {item.reference}@{item.versions[0]}
                          </p>
                        </div>
                        {value.includes(`${item.reference}@${item.versions[0]}`) && (
                          <CheckIcon className="mt-0.5 size-3.5 shrink-0" />
                        )}
                      </CommandItem>
                    ))}
                  </CommandList>
                </Command>
                <div className="space-y-2 border-t px-3 py-2.5">
                  {loading && (
                    <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                      <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" /> Loading skills…
                    </p>
                  )}
                  {error && (
                    <p role="alert" className="text-xs text-destructive">
                      {error}
                    </p>
                  )}
                  {credentialIssue && (
                    <p className="text-xs text-muted-foreground">
                      <Link href="/skills" className="underline underline-offset-4">
                        Manage your Skillpack key
                      </Link>{" "}
                      to browse workspace skills.
                    </p>
                  )}
                  {error && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={loading || locked}
                      onClick={() => void loadPage(items.length ? (nextOffset ?? 0) : 0, ++listRequest.current, source)}
                    >
                      Try again
                    </Button>
                  )}
                  {nextOffset !== null && !error && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={loading || locked}
                      onClick={() => void loadPage(nextOffset, ++listRequest.current, source)}
                    >
                      Load more
                    </Button>
                  )}
                  <p className="text-[11px] text-muted-foreground">Search covers loaded results only.</p>
                </div>
              </>
            )}
            {chosen && !manual && (
              <div className="space-y-3 p-3">
                <Button
                  ref={versionsBack}
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="-ml-2"
                  onClick={() => {
                    ++versionRequest.current;
                    setChosen(null);
                    setPinError(null);
                  }}
                >
                  <ChevronLeftIcon /> All skills
                </Button>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{chosen.name}</p>
                    <Visibility source={chosen.visibility} />
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">{chosen.description}</p>
                  <p className="break-all font-mono text-xs text-muted-foreground">{chosen.reference}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-version`}>Version</Label>
                  <NativeSelect
                    ref={versionSelect}
                    id={`${id}-version`}
                    value={version}
                    onChange={(event) => setVersion(event.target.value)}
                    disabled={locked || versionLoading || !versions.length}
                  >
                    {!versions.length && (
                      <option value="">{versionLoading ? "Loading versions…" : "No version available"}</option>
                    )}
                    {versions.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                {versionError && (
                  <p role="alert" className="text-xs text-destructive">
                    {versionError}
                  </p>
                )}
                {pinError && (
                  <p role="alert" className="text-xs text-destructive">
                    {pinError}
                  </p>
                )}
                <Button
                  type="button"
                  size="sm"
                  className="w-full"
                  disabled={locked || versionLoading || !version || !!versionError}
                  onClick={() => add(`${chosen.reference}@${version}`, chosen)}
                >
                  Add skill
                </Button>
              </div>
            )}
            {manual && (
              <div className="space-y-3 p-3">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="-ml-2"
                  onClick={() => {
                    ++versionRequest.current;
                    setChosen(null);
                    setManual(false);
                    setPinError(null);
                  }}
                >
                  <ChevronLeftIcon /> Browse skills
                </Button>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-pin`}>Exact skill pin</Label>
                  <Input
                    ref={exactPinInput}
                    id={`${id}-pin`}
                    value={pin}
                    onChange={(event) => {
                      setPin(event.target.value);
                      setPinError(null);
                    }}
                    placeholder="org/skill@1.2.3"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={locked}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.stopPropagation();
                        if (pin.trim()) add(pin.trim());
                      }
                    }}
                  />
                  <p className="text-xs leading-5 text-muted-foreground">{SKILL_PIN_HINT}</p>
                </div>
                {pinError && (
                  <p role="alert" className="text-xs text-destructive">
                    {pinError}
                  </p>
                )}
                <Button
                  type="button"
                  size="sm"
                  className="w-full"
                  disabled={locked || !pin.trim()}
                  onClick={() => add(pin.trim())}
                >
                  Add pin
                </Button>
              </div>
            )}
            {!manual && (
              <div className="border-t px-3 py-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="w-full justify-start text-muted-foreground"
                  onClick={() => {
                    ++versionRequest.current;
                    setManual(true);
                    setPinError(null);
                  }}
                >
                  Enter exact pin
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
      {value.length > 0 && (
        <ul aria-label="Additional skills" className="divide-y rounded-md border">
          {value.map((exact) => {
            const item = names[exact];
            return (
              <li key={exact} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1 space-y-0.5">
                  {item && <p className="truncate text-xs font-medium">{item.name}</p>}
                  <p className="break-all font-mono text-xs text-muted-foreground">{exact}</p>
                </div>
                <Visibility source={exact.includes("/") ? "public" : "private"} />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8 shrink-0 text-muted-foreground"
                  disabled={locked}
                  aria-label={`Remove ${exact}`}
                  onClick={() => onChange(value.filter((entry) => entry !== exact))}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
