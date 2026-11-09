// The story's diagrams (#587): flat shapes and one outline weight, drawn in the
// hero's vocabulary (a sandbox is a ship of the mark). Each one says what its
// chapter says, so each is an image with words a screen reader reads. Their
// colours come from the chapter (`--ch-*` in landing.css), never from here.
import type { ReactNode } from "react";
import { CIPHER, GITHUB_TOKEN_HOURS } from "./content";

function Figure({ label, view, children }: { label: string; view: string; children: ReactNode }) {
  return (
    <svg className="lp-fig" viewBox={view} role="img" aria-label={label}>
      {children}
    </svg>
  );
}

/** A ship of the mark, pointing up, centred on (x, y). */
function Ship({ x, y, size = 30, className = "is-lime" }: { x: number; y: number; size?: number; className?: string }) {
  const h = size * 0.875;
  return (
    <path
      className={`lp-fig-ship ${className}`}
      d={`M${x} ${y - h / 2}L${x + size / 2} ${y + h / 2}H${x - size / 2}Z`}
    />
  );
}

function Check({ x, y }: { x: number; y: number }) {
  return (
    <g className="lp-fig-check">
      <circle cx={x} cy={y} r={14} />
      <path d={`M${x - 6} ${y}l4.5 4.5 8-9`} />
    </g>
  );
}

const REPOS = [
  { name: "acme/widgets", branch: "main" },
  { name: "acme/api", branch: "main" },
  { name: "acme/ui", branch: "release" },
];

/** One build per provider: a golden saved on Boat does not move to Modal; it is built there again. */
const PROVIDERS = [
  { name: "Boat", y: 16 },
  { name: "Modal", y: 280 },
];

export function GoldenFigure() {
  return (
    <Figure
      view="0 0 640 540"
      label="Three repositories feed two separate builds: a golden built and saved on Boat, and another built and saved on Modal. Each build clones as you, runs the setup, scans for GitHub tokens and saves its own snapshot."
    >
      {REPOS.map((r, k) => {
        const y = 24 + k * 132;
        return (
          <g key={r.name}>
            <rect className="lp-fig-card is-night" x={8} y={y} width={256} height={100} rx={20} />
            <circle className="lp-fig-dot" cx={40} cy={y + 50} r={10} />
            <text className="lp-fig-t is-on-ink" x={62} y={y + 46}>
              {r.name}
            </text>
            <text className="lp-fig-s is-on-ink" x={62} y={y + 74}>
              {r.branch}
            </text>
            <path className="lp-fig-wire" d={`M264 ${y + 50}C284 ${y + 50} 280 206 296 206`} />
          </g>
        );
      })}
      <path className="lp-fig-wire" d="M296 206C312 206 304 138 322 138M296 206C312 206 304 402 322 402" />
      <circle className="lp-fig-node" cx={296} cy={206} r={8} />
      {PROVIDERS.map((p) => (
        <g key={p.name}>
          <rect className="lp-fig-card is-night" x={322} y={p.y} width={310} height={244} rx={26} />
          <text className="lp-fig-t is-big is-on-ink" x={346} y={p.y + 48}>
            Built on {p.name}
          </text>
          <rect className="lp-fig-ink" x={338} y={p.y + 68} width={278} height={160} rx={16} />
          {["cloned as you", "set up, scanned", "snapshot saved"].map((t, k) => (
            <g key={t}>
              <Check x={366} y={p.y + 104 + k * 46} />
              <text className="lp-fig-s is-on-ink" x={392} y={p.y + 112 + k * 46}>
                {t}
              </text>
            </g>
          ))}
        </g>
      ))}
    </Figure>
  );
}

const SANDBOXES = [
  { agent: "Claude Code", model: "claude-opus-5-5", effort: "high", status: "running", ship: "is-lime" },
  { agent: "Codex", model: "gpt-6.1-sol", effort: "medium", status: "running", ship: "is-sky" },
  { agent: "Claude Code", model: "claude-opus-5-5", effort: "low", status: "ready", ship: "is-orange" },
  { agent: "Codex", model: "gpt-6.1-sol", effort: "high", status: "running", ship: "is-amber" },
];

export function FleetFigure() {
  return (
    <Figure
      view="0 0 640 540"
      label="One golden forks into four sandboxes, each with its own agent, model and reasoning effort: two Claude Code, two Codex."
    >
      <rect className="lp-fig-card is-lime" x={8} y={200} width={170} height={140} rx={24} />
      <Ship x={93} y={248} size={34} className="is-ink" />
      <text className="lp-fig-t" x={93} y={300} textAnchor="middle">
        widgets
      </text>
      <text className="lp-fig-s" x={93} y={326} textAnchor="middle">
        golden
      </text>
      {SANDBOXES.map((s, k) => {
        const y = 12 + k * 132;
        return (
          <g key={`${s.agent}-${s.effort}`}>
            <path className="lp-fig-wire" d={`M178 270C224 270 214 ${y + 56} 252 ${y + 56}`} />
            <rect className="lp-fig-card is-night" x={252} y={y} width={380} height={112} rx={22} />
            <Ship x={292} y={y + 56} size={32} className={s.ship} />
            <text className="lp-fig-t is-on-ink" x={326} y={y + 48}>
              {s.agent}
            </text>
            <text className="lp-fig-s is-on-ink is-mono" x={326} y={y + 80}>
              {s.model}
            </text>
            <rect className="lp-fig-pill" x={518} y={y + 22} width={98} height={32} rx={16} />
            <text className="lp-fig-xs is-on-ink" x={567} y={y + 45} textAnchor="middle">
              {s.effort}
            </text>
            <text className={`lp-fig-xs is-${s.status}`} x={567} y={y + 84} textAnchor="middle">
              {s.status}
            </text>
          </g>
        );
      })}
    </Figure>
  );
}

const TOOLS = [
  { name: "docs", how: "HTTP, OAuth", x: 8, y: 20 },
  { name: "tracker", how: "SSE, bearer", x: 392, y: 20 },
  { name: "local-db", how: "stdio", x: 200, y: 412 },
];

export function ToolsFigure() {
  return (
    <Figure
      view="0 0 640 540"
      label="A sandbox wired to three MCP connections: docs over HTTP with OAuth, a tracker over SSE with a bearer token, and a local database over stdio."
    >
      <path className="lp-fig-wire is-thick" d="M128 120V186C128 220 160 230 214 236" />
      <path className="lp-fig-wire is-thick" d="M512 120V186C512 220 480 230 426 236" />
      <path className="lp-fig-wire is-thick" d="M320 344V412" />
      <rect className="lp-fig-ink" x={214} y={176} width={212} height={168} rx={26} />
      <Ship x={320} y={226} size={44} />
      <text className="lp-fig-t is-on-ink" x={320} y={292} textAnchor="middle">
        sandbox
      </text>
      <text className="lp-fig-s is-on-ink" x={320} y={322} textAnchor="middle">
        Codex
      </text>
      {TOOLS.map((t) => (
        <g key={t.name}>
          <rect className="lp-fig-card is-night" x={t.x} y={t.y} width={240} height={100} rx={20} />
          <rect className="lp-fig-plug" x={t.x + 22} y={t.y + 32} width={36} height={36} rx={9} />
          <path className="lp-fig-prong" d={`M${t.x + 32} ${t.y + 32}v-10M${t.x + 48} ${t.y + 32}v-10`} />
          <text className="lp-fig-t is-on-ink" x={t.x + 76} y={t.y + 46}>
            {t.name}
          </text>
          <text className="lp-fig-s is-on-ink" x={t.x + 76} y={t.y + 76}>
            {t.how}
          </text>
        </g>
      ))}
    </Figure>
  );
}

/** A disk (the sandbox's files) and a speech bubble (the agent's conversation), at (x, y). */
function Kept({ x, y, fresh = false }: { x: number; y: number; fresh?: boolean }) {
  return (
    <g>
      <rect className="lp-fig-card is-night" x={x} y={y} width={58} height={44} rx={10} />
      <path className="lp-fig-line" d={`M${x + 12} ${y + 30}h34`} />
      <path
        className={`lp-fig-card ${fresh ? "is-lime" : "is-night"}`}
        d={`M${x + 74} ${y}h70a12 12 0 0 1 12 12v22a12 12 0 0 1-12 12h-48l-14 12v-12h-8a12 12 0 0 1-12-12v-22a12 12 0 0 1 12-12z`}
      />
      <path className="lp-fig-line" d={`M${x + 90} ${y + 16}h46M${x + 90} ${y + 30}h${fresh ? 30 : 38}`} />
    </g>
  );
}

export function ResumeFigure() {
  return (
    <Figure
      view="0 0 640 540"
      label="Stopping a sandbox removes its machine and keeps its disk and conversation; the next prompt brings a machine back with both."
    >
      {[
        { y: 16, title: "running", machine: "solid" },
        { y: 196, title: "stopped", machine: "gone" },
        { y: 376, title: "running again", machine: "solid" },
      ].map((s, k) => (
        <g key={s.title}>
          <rect
            className={s.machine === "gone" ? "lp-fig-ghost" : "lp-fig-ink"}
            x={150}
            y={s.y}
            width={482}
            height={148}
            rx={26}
          />
          <text className={`lp-fig-t ${s.machine === "gone" ? "" : "is-on-ink"}`} x={182} y={s.y + 50}>
            {s.title}
          </text>
          <Kept x={440} y={s.y + 50} fresh={k === 2} />
          {s.machine === "gone" ? (
            <text className="lp-fig-s" x={182} y={s.y + 84}>
              no machine, no cost
            </text>
          ) : (
            <Ship x={200} y={s.y + 100} size={34} />
          )}
        </g>
      ))}
      <path className="lp-fig-wire is-thick" d="M70 90V510" />
      <circle className="lp-fig-node" cx={70} cy={90} r={12} />
      <circle className="lp-fig-node is-hollow" cx={70} cy={270} r={12} />
      <circle className="lp-fig-node" cx={70} cy={450} r={12} />
      <text className="lp-fig-t" x={92} y={190} textAnchor="end" transform="rotate(-90 92 190)">
        stop
      </text>
      <text className="lp-fig-t" x={92} y={370} textAnchor="end" transform="rotate(-90 92 370)">
        send
      </text>
    </Figure>
  );
}

const DOORS = [
  { name: "Dashboard", sub: "on the web", x: 8, glyph: "web" },
  { name: "armada CLI", sub: "in a terminal", x: 220, glyph: "cli" },
  { name: "Your agent", sub: "over MCP", x: 432, glyph: "mcp" },
] as const;

function Glyph({ kind, x, y }: { kind: (typeof DOORS)[number]["glyph"]; x: number; y: number }) {
  if (kind === "web")
    return (
      <g>
        <rect className="lp-fig-card is-night" x={x} y={y} width={56} height={42} rx={8} />
        <path className="lp-fig-line" d={`M${x} ${y + 12}h56`} />
      </g>
    );
  if (kind === "cli")
    return (
      <g>
        <rect className="lp-fig-ink" x={x} y={y} width={56} height={42} rx={8} />
        <path className="lp-fig-prompt" d={`M${x + 12} ${y + 14}l9 7-9 7M${x + 28} ${y + 30}h14`} />
      </g>
    );
  return (
    <path
      className="lp-fig-card is-lime"
      d={`M${x + 10} ${y}h36a10 10 0 0 1 10 10v20a10 10 0 0 1-10 10h-22l-12 10v-10h-2a10 10 0 0 1-10-10v-20a10 10 0 0 1 10-10z`}
    />
  );
}

export function ControlFigure() {
  return (
    <Figure
      view="0 0 640 540"
      label="The dashboard, the armada CLI and your agent over MCP all go through one Armada API with one set of rules, to the same sandboxes."
    >
      {DOORS.map((d) => (
        <g key={d.name}>
          <rect className="lp-fig-card is-night" x={d.x} y={16} width={200} height={168} rx={22} />
          <Glyph kind={d.glyph} x={d.x + 24} y={40} />
          <text className="lp-fig-t is-on-ink" x={d.x + 24} y={130}>
            {d.name}
          </text>
          <text className="lp-fig-s is-on-ink" x={d.x + 24} y={160}>
            {d.sub}
          </text>
          <path className="lp-fig-wire is-thick" d={`M${d.x + 100} 184V240`} />
        </g>
      ))}
      <rect className="lp-fig-ink" x={8} y={240} width={624} height={112} rx={26} />
      <text className="lp-fig-t is-on-ink is-big" x={36} y={292}>
        One Armada API
      </text>
      <text className="lp-fig-s is-on-ink" x={36} y={326}>
        the same rules for every door
      </text>
      <path className="lp-fig-wire is-thick" d="M320 352V404" />
      {["is-lime", "is-sky", "is-orange", "is-amber", "is-paper"].map((c, k) => (
        <g key={c}>
          <rect className="lp-fig-card is-night" x={8 + k * 128} y={404} width={112} height={112} rx={20} />
          <Ship x={64 + k * 128} y={460} size={40} className={c} />
        </g>
      ))}
    </Figure>
  );
}

export function KeysFigure() {
  return (
    <Figure
      view="0 0 640 540"
      label={`The vault seals each key with ${CIPHER}. Of the stored keys, a sandbox receives only its agent's, plus a GitHub token valid for ${GITHUB_TOKEN_HOURS} hours; a golden receives no key.`}
    >
      <rect className="lp-fig-card is-lime" x={8} y={170} width={236} height={200} rx={26} />
      <rect className="lp-fig-ink" x={96} y={204} width={60} height={50} rx={10} />
      <path className="lp-fig-shackle" d="M108 204v-12a18 18 0 0 1 36 0v12" />
      <text className="lp-fig-t" x={126} y={302} textAnchor="middle">
        Armada
      </text>
      <text className="lp-fig-s is-mono" x={126} y={334} textAnchor="middle">
        {CIPHER}
      </text>
      <path className="lp-fig-wire is-thick" d="M244 230C300 230 290 104 344 104" />
      <path className="lp-fig-wire is-thick is-cut" d="M244 310C300 310 290 436 344 436" />
      <rect className="lp-fig-card is-night" x={344} y={16} width={288} height={176} rx={24} />
      <Ship x={380} y={58} size={30} />
      <text className="lp-fig-t is-on-ink" x={408} y={67}>
        sandbox
      </text>
      <rect className="lp-fig-pill is-key" x={370} y={92} width={236} height={36} rx={18} />
      <text className="lp-fig-xs" x={488} y={116} textAnchor="middle">
        its agent's key
      </text>
      <rect className="lp-fig-pill is-key" x={370} y={140} width={236} height={36} rx={18} />
      <text className="lp-fig-xs" x={488} y={164} textAnchor="middle">
        GitHub, {GITHUB_TOKEN_HOURS} hours
      </text>
      <rect className="lp-fig-card is-night" x={344} y={348} width={288} height={176} rx={24} />
      <text className="lp-fig-t is-on-ink" x={372} y={400}>
        golden
      </text>
      <text className="lp-fig-s is-on-ink" x={372} y={436}>
        no keys, ever
      </text>
      <text className="lp-fig-s is-on-ink" x={372} y={468}>
        a token found stops
      </text>
      <text className="lp-fig-s is-on-ink" x={372} y={496}>
        its snapshot
      </text>
      <circle className="lp-fig-stop" cx={294} cy={370} r={18} />
      <path className="lp-fig-stop-x" d="M286 362l16 16M302 362l-16 16" />
    </Figure>
  );
}
