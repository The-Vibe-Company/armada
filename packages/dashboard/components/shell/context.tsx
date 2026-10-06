"use client";

// What every page of the shell reads (THE-866): the overview the shell polls,
// the clock, the language, the viewer's time zone and who is signed in. The shell polls
// the server for a new overview: every 5 s while work is in flight, every 30 s
// when the fleet is quiet, never while the tab is hidden (THE-853: nothing
// runs when nobody looks). Each poll names the overview it holds, and the
// server answers 304 while nothing changed. Pages render from this context,
// so moving between them never waits for the server.
import type { FleetOverview } from "@armada/core/read";
import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LANGUAGE_COOKIE, type Language, STRINGS, type Strings } from "@/lib/i18n";

/** Polls while a worker is in flight, a request waits for the coordinator or a project is being read. */
const BUSY_POLL_MS = 5_000;
/** Polls while the fleet is quiet. */
const IDLE_POLL_MS = 30_000;

/** Something on the page may change within seconds. */
const isBusy = (o: FleetOverview) =>
  o.rows.length > 0 ||
  o.projects.some((p) => p.reading) ||
  o.waiting.some((w) => w.answer !== null) ||
  o.ready.some((r) => r.launch !== null);

/** The signed-in person and their organizations, as the sidebar shows them. */
export interface Account {
  canSetSecrets?: boolean;
  name: string;
  email: string;
  organization: { id: string; name: string };
  organizations: { id: string; name: string }[];
}

export interface Fleet {
  overview: FleetOverview;
  /** When the last poll answered; null before the first. */
  checkedAt: number | null;
  failed: boolean;
  pending: boolean;
  /** Bumped by every answered poll, 304 included. */
  version: number;
  refresh: () => void;
}

export interface Shell {
  t: Strings;
  lang: Language;
  setLanguage: (lang: Language) => void;
  /** The viewer's time zone (the `armada-tz` cookie on the server, the browser's own once it runs): "today" is its day. */
  zone: string;
  /** With accounts; null under the shared-password gate. */
  account: Account | null;
  /** The shared-password gate's log out. */
  canLogOut: boolean;
  /** The name that signs the viewer's requests; empty until they give one (password gate only). */
  author: string;
  setAuthor: (name: string) => void;
}

const FleetContext = createContext<Fleet | null>(null);
const ShellContext = createContext<Shell | null>(null);
const NowContext = createContext<number>(0);

function useLiveOverview(initial: FleetOverview, initialTag: string | null): Fleet {
  const [overview, setOverview] = useState(initial);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [version, setVersion] = useState(0);
  const inFlight = useRef(false);
  /** The ETag of the overview shown; the server answers 304 while it is still current. */
  const tag = useRef<string | null>(initialTag);
  const busy = useRef(isBusy(initial));
  /** When the overview shown was built: an older one, from a poll or a render, never replaces it. */
  const shown = useRef(initial.generatedAt);
  const show = useCallback((next: FleetOverview) => {
    if (next.generatedAt < shown.current) return false;
    shown.current = next.generatedAt;
    busy.current = isBusy(next);
    setOverview(next);
    return true;
  }, []);

  // A server render (a language change, an action) brings a newer overview: take it.
  useEffect(() => {
    show(initial);
  }, [initial, show]);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    // Every update of a poll is a transition (THE-892): the whole page renders
    // from the overview, and React renders it in slices the next input can cut.
    startTransition(() => setPending(true));
    try {
      const res = await fetch("/api/fleet", {
        cache: "no-store",
        headers: tag.current ? { "If-None-Match": tag.current } : {},
      });
      if (res.status === 401 || new URL(res.url).pathname === "/login") {
        // The session ended (expired, logged out, or the password changed).
        const here = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/login${here === "/" ? "" : `?next=${encodeURIComponent(here)}`}`);
        return;
      }
      const next = res.status === 304 ? null : res.ok ? ((await res.json()) as FleetOverview) : null;
      if (res.status !== 304 && !next) throw new Error(String(res.status));
      startTransition(() => {
        // A poll that answers after a newer render is dropped, with its tag.
        if (next && show(next)) tag.current = res.headers.get("etag");
        setVersion((v) => v + 1);
        setFailed(false);
        setCheckedAt(Date.now());
      });
    } catch {
      startTransition(() => setFailed(true));
    } finally {
      inFlight.current = false;
      startTransition(() => setPending(false));
    }
  }, [show]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let visible = false;
    // Each start begins a new loop; a poll still running from an older one does not schedule another.
    let loop = 0;
    const next = (mine: number) => {
      timer = setTimeout(
        async () => {
          await poll();
          if (visible && mine === loop) next(mine);
        },
        busy.current ? BUSY_POLL_MS : IDLE_POLL_MS,
      );
    };
    const start = () => {
      if (visible) return;
      visible = true;
      loop++;
      void poll();
      next(loop);
    };
    const stop = () => {
      visible = false;
      loop++;
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [poll]);

  return useMemo(
    () => ({ overview, checkedAt, failed, pending, version, refresh: () => void poll() }),
    [overview, checkedAt, failed, pending, version, poll],
  );
}

/** A clock ticking every second, started from the server's so the first render matches the HTML. */
function useClock(initial: string) {
  const [now, setNow] = useState(() => Date.parse(initial));
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const remember = (name: string, value: string) => {
  // biome-ignore lint/suspicious/noDocumentCookie: a plain preference cookie, read by the server on the next load.
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
};

export function FleetProvider({
  initial,
  initialTag = null,
  initialLanguage,
  zone: initialZone,
  account,
  canLogOut,
  initialAuthor,
  children,
}: {
  initial: FleetOverview;
  initialTag?: string | null;
  initialLanguage: Language;
  zone: string;
  account: Account | null;
  canLogOut: boolean;
  initialAuthor: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const fleet = useLiveOverview(initial, initialTag);
  const now = useClock(initial.generatedAt);
  const [lang, setLang] = useState(initialLanguage);
  const [author, setAuthor] = useState(initialAuthor);
  // The cookie's zone renders on the server; the browser's own takes over once it runs (a first visit has no cookie).
  const [zone, setZone] = useState(initialZone);
  useEffect(() => {
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (own) setZone(own);
  }, []);

  const shell = useMemo<Shell>(
    () => ({
      t: STRINGS[lang],
      lang,
      setLanguage: (next) => {
        setLang(next);
        document.documentElement.lang = next;
        document.title = STRINGS[next].htmlTitle;
        remember(LANGUAGE_COOKIE, next);
        // Server-rendered pages (the organization's) follow.
        router.refresh();
      },
      zone,
      account,
      canLogOut,
      author,
      setAuthor,
    }),
    [lang, zone, account, canLogOut, author, router],
  );

  return (
    <ShellContext.Provider value={shell}>
      <FleetContext.Provider value={fleet}>
        <NowContext.Provider value={now}>{children}</NowContext.Provider>
      </FleetContext.Provider>
    </ShellContext.Provider>
  );
}

/**
 * A fleet shown, not polled (the landing's replica, THE-887): the overview, the
 * time and the viewer it is given, in English. The dashboard's own components
 * render inside it as they do in the shell.
 */
export function ShowcaseProvider({
  overview,
  now,
  account = null,
  children,
}: {
  overview: FleetOverview;
  now: number;
  account?: Account | null;
  children: ReactNode;
}) {
  const shell = useMemo<Shell>(
    () => ({
      t: STRINGS.en,
      lang: "en",
      setLanguage: () => {},
      zone: "UTC",
      account,
      canLogOut: false,
      author: account?.name ?? "",
      setAuthor: () => {},
    }),
    [account],
  );
  const fleet = useMemo<Fleet>(
    () => ({
      overview,
      checkedAt: now,
      failed: false,
      pending: false,
      version: 0,
      refresh: () => {},
    }),
    [overview, now],
  );
  return (
    <ShellContext.Provider value={shell}>
      <FleetContext.Provider value={fleet}>
        <NowContext.Provider value={now}>{children}</NowContext.Provider>
      </FleetContext.Provider>
    </ShellContext.Provider>
  );
}

function required<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`${name} is used outside the shell`);
  return value;
}

/** The overview the shell polls, and its state. */
export const useFleet = () => required(useContext(FleetContext), "useFleet");
/** The language, time zone and viewer. */
export const useShell = () => required(useContext(ShellContext), "useShell");
/** The time, in ms, ticking every second. */
export const useNow = () => useContext(NowContext);
