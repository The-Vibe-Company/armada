"use client";

import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { type ITheme, Terminal } from "@xterm/xterm";
import {
  CheckIcon,
  CopyIcon,
  Maximize2Icon,
  Minimize2Icon,
  RotateCwIcon,
  TerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { mintRelayTicket } from "@/app/actions/sandboxes";
import { StatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { createRelayClient, type RelayClientState, type RelayConnectionPhase } from "@/lib/relay-client";
import type { Tone } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

const KEYS =
  "background foreground cursor cursorAccent selectionBackground black red green yellow blue magenta cyan white brightBlack brightRed brightGreen brightYellow brightBlue brightMagenta brightCyan brightWhite".split(
    " ",
  );
const parseTheme = (spec: string) => Object.fromEntries(spec.split("|").map((v, i) => [KEYS[i], v])) as ITheme;
const THEMES = {
  dark: parseTheme(
    "#121317|#eef0f4|#b6f15a|#121317|rgba(182,241,90,0.24)|#181a1f|#f07178|#a9dc76|#ffd866|#78a9ff|#c792ea|#78dce8|#e2e5ec|#5c6370|#ff8c94|#b6f15a|#ffe58f|#9ec1ff|#deb3f5|#9ce8f2|#ffffff",
  ),
  light: parseTheme(
    "#f6f7f9|#1f232b|#4a7c12|#f6f7f9|rgba(104,159,28,0.22)|#1f232b|#c83232|#2f7a3e|#946200|#2563c9|#8942b8|#0e7490|#e5e7eb|#646c7a|#dc2626|#3f8f29|#b45309|#3b82f6|#a855f7|#0891b2|#ffffff",
  ),
};
const DEFAULT_H = 272,
  MIN_H = 160,
  EXPANDED_H = 480;
const PHASE_META: Record<RelayConnectionPhase, readonly [string, Tone, boolean]> = {
  idle: ["Idle", "neutral", false],
  minting: ["Connecting…", "warning", true],
  connecting: ["Connecting…", "warning", true],
  authenticating: ["Authenticating…", "warning", true],
  opening: ["Starting shell…", "info", true],
  connected: ["Connected", "success", false],
  reconnecting: ["Reconnecting…", "warning", true],
  disconnected: ["Disconnected", "neutral", false],
  error: ["Disconnected", "destructive", false],
};

export function SandboxTerminal({ sandboxId, onClose }: { sandboxId: string; onClose: () => void }) {
  const { resolvedTheme } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const refs = useRef<{ term: Terminal; fit: FitAddon; client: ReturnType<typeof createRelayClient> } | null>(null);
  const [relay, setRelay] = useState<RelayClientState>({ phase: "minting", canReconnect: false });
  const [height, setHeight] = useState(DEFAULT_H);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drag = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => () => clearTimeout(copyTimer.current), []);
  useEffect(() => {
    if (refs.current) refs.current.term.options.theme = resolvedTheme === "dark" ? THEMES.dark : THEMES.light;
  }, [resolvedTheme]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-geist-mono").trim();
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 12.5,
      lineHeight: 1.38,
      scrollback: 5_000,
      macOptionIsMeta: true,
      fontFamily: `${mono ? `${mono}, ` : ""}ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
      theme: document.documentElement.classList.contains("dark") ? THEMES.dark : THEMES.light,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    fit.fit();
    term.focus();
    term.attachCustomKeyEventHandler(
      (ev) => !(ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey && ev.code === "Backquote"),
    );
    const client = createRelayClient({
      mintTicket: () => mintRelayTicket(sandboxId, { mode: "pty" }),
      onState: setRelay,
      onData: (data, ack) => term.write(data, ack),
    });
    refs.current = { term, fit, client };
    const disposers = [
      term.onData((t) => client.sendInput(t)),
      term.onBinary((raw) => client.sendInput(Uint8Array.from(raw, (c) => c.charCodeAt(0) & 0xff))),
      term.onResize(({ cols, rows }) => client.resize(cols, rows)),
    ];
    const observer = new ResizeObserver(() => el.clientWidth > 0 && el.clientHeight > 0 && fit.fit());
    observer.observe(el);
    void client.connect(term.cols, term.rows);
    return () => {
      observer.disconnect();
      for (const d of disposers) d.dispose();
      client.disconnect();
      term.dispose();
      refs.current = null;
    };
  }, [sandboxId]);

  const expanded = height >= EXPANDED_H - 24;
  const clampH = (n: number) => Math.min(Math.max(MIN_H, Math.round(window.innerHeight * 0.68)), Math.max(MIN_H, n));
  const reconnect = () => {
    if (!refs.current) return;
    refs.current.fit.fit();
    void refs.current.client.connect(refs.current.term.cols, refs.current.term.rows, { reconnect: true });
    refs.current.term.focus();
  };
  const copyOutput = async () => {
    const term = refs.current?.term;
    const text =
      term?.getSelection() ||
      Array.from(
        { length: term?.buffer.active.length ?? 0 },
        (_, i) => term?.buffer.active.getLine(i)?.translateToString(true) ?? "",
      )
        .join("\n")
        .trimEnd();
    if (!text) return;
    clearTimeout(copyTimer.current);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  const endDrag = (ev: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (ev.currentTarget.hasPointerCapture(ev.pointerId)) ev.currentTarget.releasePointerCapture(ev.pointerId);
  };

  const [label, tone, pulse] = PHASE_META[relay.phase];
  const showBanner = (relay.phase === "disconnected" || relay.phase === "error") && relay.message;
  const iconCls = "text-muted-foreground hover:text-foreground";

  return (
    <section
      aria-label="Sandbox terminal"
      data-slot="sandbox-terminal"
      className={cn(
        "flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-[var(--sunken)] shadow-xs",
        dragging && "select-none",
      )}
    >
      <button
        type="button"
        aria-label="Resize terminal"
        onPointerDown={(ev) => {
          if (ev.button !== 0) return;
          ev.currentTarget.setPointerCapture(ev.pointerId);
          drag.current = { y: ev.clientY, h: height };
          setDragging(true);
        }}
        onPointerMove={(ev) => drag.current && setHeight(clampH(drag.current.h + (drag.current.y - ev.clientY)))}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(ev) => {
          if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
          ev.preventDefault();
          setHeight(clampH(height + (ev.key === "ArrowUp" ? 24 : -24)));
        }}
        onDoubleClick={() => setHeight(DEFAULT_H)}
        className="group flex h-2 w-full cursor-row-resize items-center justify-center bg-[var(--surface)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          aria-hidden="true"
          className={cn(
            "h-0.5 w-8 rounded-full bg-border transition-[background-color,width] duration-150 ease-(--ease-out) group-hover:w-10 group-hover:bg-muted-foreground/50",
            dragging && "w-12 bg-foreground/50",
          )}
        />
      </button>

      <div className="flex h-9 items-center gap-2 border-b border-border/80 bg-[var(--surface)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="text-xs font-medium text-foreground">Terminal</span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-[var(--sunken)] px-2 py-0.5 text-[11px] text-muted-foreground">
            <StatusDot tone={tone} pulse={pulse} />
            <span>{label}</span>
          </span>
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <Kbd className="mr-1.5 hidden text-[10px] sm:inline-flex">Ctrl+`</Kbd>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!relay.canReconnect}
            onClick={reconnect}
            className={iconCls}
          >
            <RotateCwIcon />
            <span className="hidden sm:inline">Reconnect</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Copy terminal selection or output"
            title={copied ? "Copied" : "Copy selection (or buffer)"}
            onClick={copyOutput}
            className={cn(iconCls, copied && "text-success hover:text-success")}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Clear terminal"
            title="Clear terminal"
            onClick={() => {
              refs.current?.term.clear();
              refs.current?.term.focus();
            }}
            className={iconCls}
          >
            <Trash2Icon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={expanded ? "Restore terminal height" : "Expand terminal"}
            title={expanded ? "Restore height" : "Expand height"}
            onClick={() =>
              setHeight(expanded ? DEFAULT_H : Math.max(EXPANDED_H, Math.round(window.innerHeight * 0.56)))
            }
            className={iconCls}
          >
            {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Close terminal"
            title="Close terminal (Ctrl+`)"
            onClick={onClose}
            className={iconCls}
          >
            <XIcon />
          </Button>
        </div>
      </div>

      {showBanner && (
        <div
          role={relay.phase === "error" ? "alert" : "status"}
          className="flex flex-wrap items-center justify-between gap-2 border-b border-border/80 bg-[var(--surface)] px-3 py-1.5 text-xs"
        >
          <span className={relay.phase === "error" ? "text-destructive" : "text-muted-foreground"}>
            {relay.message}
          </span>
          {relay.canReconnect && (
            <Button type="button" variant="outline" size="xs" onClick={reconnect}>
              <RotateCwIcon />
              Reconnect
            </Button>
          )}
        </div>
      )}

      <div className="min-h-0 w-full bg-[var(--sunken)]" style={{ height }}>
        <div
          ref={hostRef}
          className="h-full w-full overflow-hidden px-2.5 py-2 [&_.xterm]:h-full [&_.xterm-viewport]:bg-transparent!"
        />
      </div>
    </section>
  );
}
