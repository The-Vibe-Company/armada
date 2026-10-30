// A message as markdown (THE-2050), after T3 Code's ChatMarkdown: GitHub's
// flavour, raw HTML parsed then sanitized, code blocks as a card with Copy and
// Wrap lines, tables that scroll with their copy menu, GitHub's alerts, the
// `<details>` disclosure, links that leave the app opening outside it (the
// desktop shell hands them to the system browser), and the ids a message names
// linked: a ticket to its session in its state's colour, `#34` to its pull
// request. The room is its own chunk, so none of this weighs on first paint.
import {
  ChevronRight,
  Info,
  Lightbulb,
  type LucideIcon,
  MessageSquareWarning,
  OctagonAlert,
  TriangleAlert,
  WrapText,
} from "lucide-react";
import {
  type ComponentProps,
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { TONE } from "@/components/fleet/FleetList";
import type { Group } from "@/fleet/overview";
import { cn } from "@/lib/utils";
import { CopyButton, CopyGlyph, IconButton, useCopy } from "./Copy";
import {
  type Alert,
  fenceLanguage,
  fenceTitle,
  leaves,
  remarkAlerts,
  remarkFenceMeta,
  remarkIds,
  SANITIZE,
  tableCsv,
  tableMarkdown,
} from "./markdown-rules";

const GroupOf = createContext<(ticket: string) => Group | null>(() => null);

export function Markdown({
  text,
  repository,
  groupOf,
  breaks = false,
  className,
}: {
  text: string;
  /** The project's repository (`owner/name`), for `#34`. */
  repository: string;
  groupOf: (ticket: string) => Group | null;
  /** Keep single line breaks (the owner's text, as typed). */
  breaks?: boolean;
  className?: string;
}) {
  const remark = useMemo<Options["remarkPlugins"]>(
    () => [remarkGfm, ...(breaks ? [remarkBreaks] : []), remarkAlerts, remarkFenceMeta, [remarkIds, { repository }]],
    [breaks, repository],
  );
  return (
    <GroupOf value={groupOf}>
      <div className={cn("chat-markdown min-w-0 text-sub text-text/90 leading-relaxed", className)}>
        <ReactMarkdown remarkPlugins={remark} rehypePlugins={REHYPE} components={COMPONENTS}>
          {text}
        </ReactMarkdown>
      </div>
    </GroupOf>
  );
}

/** Raw HTML parsed, then everything sanitized: the plugins' marks are the only additions it keeps. */
const REHYPE: Options["rehypePlugins"] = [rehypeRaw, [rehypeSanitize, SANITIZE]];

/** Markdown's headings sit under the page's title (its one h1): `#` renders an h3 at 1.25 rem, down to h6. */
const heading =
  (Tag: "h3" | "h4" | "h5" | "h6", size: string) =>
  ({ node: _, className, ...props }: ComponentProps<"h3"> & { node?: unknown }) => (
    <Tag className={cn("chat-heading", size, className)} {...props} />
  );

const COMPONENTS: Components = {
  h1: heading("h3", "text-[1.25rem]"),
  h2: heading("h4", "text-[1.125rem]"),
  h3: heading("h5", "text-[1rem]"),
  h4: heading("h6", "text-[0.875rem]"),
  h5: heading("h6", "text-[0.875rem]"),
  h6: heading("h6", "text-[0.875rem] text-text-2"),
  a: Link,
  pre: CodeBlock,
  table: Table,
  blockquote: Quote,
  details: ({ node: _, children, ...props }) => (
    <details className="group/details my-2.5" {...props}>
      {children}
    </details>
  ),
  summary: ({ node: _, children, ...props }) => (
    <summary
      className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm font-medium text-text [&::-webkit-details-marker]:hidden"
      {...props}
    >
      <ChevronRight
        aria-hidden
        strokeWidth={1.75}
        className="size-3.5 flex-none text-text-3 transition-transform ease-out group-open/details:rotate-90"
      />
      <span>{children}</span>
    </summary>
  ),
};

/** A link: a ticket id in its state's colour to its session, the rest in the info colour; one that leaves the app opens outside it. */
function Link({ node: _, href, children, className, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  const groupOf = use(GroupOf);
  const marks = props as Record<string, unknown>;
  const ticket = typeof marks["data-ticket"] === "string" ? marks["data-ticket"] : null;
  const group = ticket ? groupOf(ticket) : null;
  const outside = leaves(href);
  // An anchor inside a message (a footnote) scrolls to it: the app's routes are `#/…`, never changed by one.
  const anchor = !outside && href && !href.startsWith("#/") ? href.slice(1) : null;
  return (
    <a
      href={href}
      {...props}
      {...(outside ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      {...(anchor !== null
        ? {
            onClick: (e: React.MouseEvent) => {
              e.preventDefault();
              document.getElementById(anchor)?.scrollIntoView({ block: "nearest" });
            },
          }
        : {})}
      className={cn(
        "rounded-xs no-underline hover:underline",
        ticket || marks["data-pr"]
          ? cn("font-mono text-meta", group && group !== "merged" ? TONE[group].text : "text-text")
          : "text-blue",
        className,
      )}
    >
      {children}
    </a>
  );
}

/** The text a node holds, however deep. */
function textOf(node: unknown): string {
  const n = node as { type?: string; value?: string; children?: unknown[] } | null;
  if (!n) return "";
  if (n.type === "text") return n.value ?? "";
  return (n.children ?? []).map(textOf).join("");
}

/** A fenced block: a rounded card, its header naming the language or the file, Wrap lines and Copy. */
function CodeBlock({ node, children, ...props }: ComponentProps<"pre"> & { node?: unknown }) {
  const code = (
    node as { children?: { type?: string; tagName?: string; properties?: Record<string, unknown> }[] }
  )?.children?.find((c) => c.type === "element" && c.tagName === "code");
  const [wrapped, setWrapped] = useState(true);
  if (!code) return <pre {...props}>{children}</pre>;
  const text = textOf(code).replace(/\n$/, "");
  const language = fenceLanguage(code.properties?.className);
  const title = fenceTitle(typeof code.properties?.dataMeta === "string" ? code.properties.dataMeta : null);
  const name = title ?? language ?? "text";
  return (
    <div
      dir="ltr"
      className="my-2.5 overflow-hidden rounded-md bg-sunken leading-snug shadow-ring"
      data-code-block
      data-language={language ?? undefined}
      data-wrap={wrapped}
    >
      <div className="flex select-none items-center justify-between gap-2 pt-1.5 pr-1.5 pl-3">
        <span className="min-w-0 truncate font-mono text-meta text-text-3" data-code-title>
          {name}
        </span>
        <span className="flex flex-none items-center gap-0.5" role="toolbar" aria-label="Code block actions">
          <IconButton label="Wrap lines" pressed={wrapped} onClick={() => setWrapped(!wrapped)}>
            <WrapText aria-hidden strokeWidth={1.75} className="size-3.5" />
          </IconButton>
          <CopyButton text={text} label="Copy code" />
        </span>
      </div>
      <pre
        {...props}
        className={cn(
          "m-0 overflow-x-auto px-3 pt-1.5 pb-3 font-mono text-body text-text-soft",
          wrapped ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre",
        )}
      >
        {children}
      </pre>
    </div>
  );
}

/** A table: row separators only, scrolling sideways in the lane with a fade where it continues, and its copy menu. */
function Table({ node: _, children, ...props }: ComponentProps<"table"> & { node?: unknown }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<"" | "start" | "end" | "both">("");
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade(start && end ? "both" : start ? "start" : end ? "end" : "");
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  const { copied, copy } = useCopy<"markdown" | "csv">();
  const rows = () =>
    [...(scroller.current?.querySelectorAll("tr") ?? [])].map((tr) =>
      [...tr.querySelectorAll("th, td")].map((cell) => (cell.textContent ?? "").trim()),
    );
  return (
    <div className="my-2.5" data-table>
      <div
        ref={scroller}
        onScroll={measure}
        className="max-w-full overflow-x-auto overscroll-x-contain"
        data-fade={fade || undefined}
        style={fade ? { maskImage: FADES[fade], WebkitMaskImage: FADES[fade] } : undefined}
      >
        <table {...props}>{children}</table>
      </div>
      <div className="mt-0.5 flex select-none items-center justify-end">
        <CopyMenu
          label={copied ? "Copied" : "Copy table"}
          done={!!copied}
          choices={[
            ["Copy as Markdown", () => copy(tableMarkdown(rows()), "markdown")],
            ["Copy as CSV", () => copy(tableCsv(rows()), "csv")],
          ]}
        />
      </div>
    </div>
  );
}

/**
 * A copy button that opens a short menu of formats: arrows move between them,
 * Escape or a click elsewhere closes it and gives the focus back. Hand-made:
 * Base UI's menu would pull its positioning into the app's first-load chunk.
 */
function CopyMenu({
  label,
  done,
  choices,
}: {
  label: string;
  done: boolean;
  choices: readonly (readonly [string, () => void])[];
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [open]);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  // Focus gone outside the button and its menu (a click elsewhere, Tab away): the menu closes.
  const wrap = useRef<HTMLDivElement>(null);
  const leave = (e: React.FocusEvent) => {
    if (open && !wrap.current?.contains(e.relatedTarget as Node | null)) close(false);
  };
  const move = (step: number) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + step + items.length) % items.length]?.focus();
  };
  return (
    <div ref={wrap} className="relative">
      <button
        ref={trigger}
        onBlur={leave}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        className="inline-flex size-6 cursor-pointer items-center justify-center rounded-sm text-text-3 transition-colors hover:bg-fill-2 hover:text-text aria-expanded:bg-fill-2"
      >
        <CopyGlyph done={done} />
      </button>
      {open && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onBlur={leave}
          onKeyDown={(e) => {
            if (e.key === "Escape") close(true);
            else if (e.key === "ArrowDown") move(1);
            else if (e.key === "ArrowUp") move(-1);
            else return;
            e.preventDefault();
          }}
          className="absolute top-full right-0 z-50 mt-1 flex min-w-40 flex-col rounded-md bg-overlay p-1 text-body text-text-2 shadow-pop"
        >
          {choices.map(([name, pick]) => (
            <button
              key={name}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                pick();
                close(true);
              }}
              className="cursor-pointer rounded-sm px-2.5 py-1.5 text-left outline-none hover:bg-fill-2 hover:text-text focus-visible:bg-fill-2 focus-visible:text-text"
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const FADE = "1.5rem";
const FADES = {
  start: `linear-gradient(to right, transparent, black ${FADE})`,
  end: `linear-gradient(to right, black calc(100% - ${FADE}), transparent)`,
  both: `linear-gradient(to right, transparent, black ${FADE}, black calc(100% - ${FADE}), transparent)`,
} as const;

/** GitHub's alerts, each with its word, its glyph and its colour; no coloured side border (Armada's direction). */
const ALERT: Record<Alert, { label: string; Icon: LucideIcon; tone: string }> = {
  note: { label: "Note", Icon: Info, tone: "text-blue" },
  tip: { label: "Tip", Icon: Lightbulb, tone: "text-green" },
  important: { label: "Important", Icon: MessageSquareWarning, tone: "text-violet" },
  warning: { label: "Warning", Icon: TriangleAlert, tone: "text-amber" },
  caution: { label: "Caution", Icon: OctagonAlert, tone: "text-red" },
};

function Quote({ node: _, children, ...props }: ComponentProps<"blockquote"> & { node?: unknown }) {
  const kind = (props as Record<string, unknown>)["data-alert"];
  const alert = typeof kind === "string" ? ALERT[kind as Alert] : undefined;
  if (!alert) return <blockquote {...props}>{children}</blockquote>;
  return (
    <div role="note" data-alert={kind as string} className="my-2.5 rounded-md bg-fill px-3 py-2 shadow-ring">
      <p className={cn("m-0 flex items-center gap-1.5 font-medium", alert.tone)}>
        <alert.Icon aria-hidden strokeWidth={1.75} className="size-3.5 flex-none" />
        {alert.label}
      </p>
      <div className="[&>:first-child]:mt-1 [&>:last-child]:mb-0">{children}</div>
    </div>
  );
}
