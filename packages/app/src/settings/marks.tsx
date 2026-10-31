// Each provider's mark (THE-2070), small, beside its name. OpenAI's and
// Anthropic's paths are T3 Code's (pingdotgg/t3code, MIT, apps/web/src/components/Icons.tsx);
// the others are drawn here, simple, in their makers' colours; a provider
// Armada has no mark for wears the generic one. THE-2075 adds the agents' and
// the connections' (`Mark`, by the catalog's `mark`): OpenCode, Linear and
// Armada's own, the shell's.
import { Sparkle } from "lucide-react";
import type { ReactNode } from "react";
import { MARK as ARMADA } from "@/components/shell/Logo";
import { cn } from "@/lib/utils";
import { type MarkName, markOf } from "./models";

const OPENAI =
  "M252.794 108.802C289.191 99.0484 326.265 110.305 351.148 135.135C385.113 126.072 422.85 134.862 449.492 161.505C476.136 188.149 484.925 225.888 475.862 259.85V259.854C500.696 284.735 511.95 321.81 502.198 358.207C492.447 394.602 464.161 421.084 430.215 430.217C421.083 464.162 394.603 492.448 358.206 502.199C321.812 511.951 284.734 500.693 259.852 475.864C225.887 484.927 188.15 476.137 161.507 449.495C134.864 422.851 126.073 385.111 135.136 351.149C110.304 326.266 99.0496 289.192 108.801 252.795C118.552 216.4 146.84 189.918 180.784 180.785C189.917 146.841 216.396 118.553 252.794 108.802ZM374.292 407.145C374.292 411.271 372.092 415.086 368.517 417.148L283.723 466.102C302.487 480.585 327.555 486.459 352.217 479.852C386.997 470.532 410.068 439.312 410.555 405.006V317.717C410.555 315.08 409.125 312.621 406.843 311.303L374.292 292.509V407.145ZM251.868 415.897C248.296 417.959 243.893 417.959 240.317 415.897L155.526 366.942C152.366 390.436 159.811 415.08 177.866 433.136H177.863C203.325 458.594 241.896 462.962 271.85 446.232L347.449 402.586C349.735 401.268 351.148 398.8 351.148 396.163V358.579L251.868 415.897ZM368.602 220.628C366.319 219.309 363.474 219.318 361.191 220.637L328.641 239.431L427.921 296.749C431.496 298.811 433.697 302.627 433.697 306.752V404.661C455.622 395.654 473.244 376.881 479.851 352.218C489.169 317.442 473.668 281.85 444.201 264.274L368.602 220.628ZM177.303 206.34C155.377 215.348 137.756 234.122 131.148 258.783C121.832 293.561 137.331 329.153 166.799 346.727L242.398 390.373C244.68 391.692 247.525 391.684 249.807 390.366L282.357 371.572L183.078 314.253C179.504 312.189 177.303 308.375 177.303 304.251V206.34ZM259.849 279.145V331.858L305.5 358.213L351.15 331.858V279.145L305.5 252.789L259.849 279.145ZM327.276 144.9C308.512 130.418 283.445 124.543 258.782 131.15C224.002 140.471 200.931 171.691 200.445 205.995V293.286C200.445 295.923 201.875 298.381 204.158 299.7L236.707 318.493V203.856C236.707 199.731 238.909 195.916 242.483 193.853L327.276 144.9ZM433.137 177.867C407.675 152.407 369.103 148.038 339.149 164.769L263.55 208.415C261.265 209.734 259.852 212.202 259.852 214.838V252.423L359.132 195.105C362.703 193.041 367.108 193.041 370.682 195.105L455.473 244.06C458.635 220.567 451.189 195.922 433.135 177.867H433.137Z";
const CLAUDE =
  "m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z";
const GITHUB =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z";
/** Linear's mark: the disc and its three cuts. */
const LINEAR =
  "M1.225 61.523c-.222-.949.908-1.546 1.597-.857l36.512 36.512c.69.69.092 1.82-.857 1.597-18.425-4.323-32.93-18.827-37.252-37.252ZM.002 46.889a.99.99 0 0 0 .29.76L52.35 99.71c.2.2.478.307.76.29 2.37-.149 4.695-.46 6.963-.927.765-.157 1.03-1.096.478-1.648L2.576 39.448c-.552-.551-1.491-.286-1.648.479a50.067 50.067 0 0 0-.926 6.962ZM4.21 29.705a.988.988 0 0 0 .208 1.1l64.776 64.776c.29.29.726.375 1.1.208a49.94 49.94 0 0 0 5.185-2.684c.552-.328.638-1.087.184-1.541L8.436 24.337c-.454-.454-1.213-.369-1.541.183a49.94 49.94 0 0 0-2.684 5.185Zm8.448-11.631c-.37-.37-.393-.964-.044-1.354C21.78 6.46 35.111 0 49.952 0 77.593 0 100 22.407 100 50.048c0 14.84-6.46 28.172-16.72 37.338-.39.348-.984.325-1.354-.045L12.659 18.074Z";
/** Mistral's pixel M: each row's cells, top to bottom, warm to red. */
const MISTRAL: readonly [string, readonly number[]][] = [
  ["#ffd800", [0, 4]],
  ["#ffaf00", [0, 1, 3, 4]],
  ["#ff8205", [0, 1, 2, 3, 4]],
  ["#fa500f", [0, 2, 4]],
  ["#e10500", [0, 4]],
];

const DRAWN: Record<Exclude<MarkName, "generic">, { box: string; draw: ReactNode }> = {
  openai: {
    box: "100 100 411 411",
    draw: <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={OPENAI} />,
  },
  anthropic: { box: "0 0 256 257", draw: <path fill="#d97757" d={CLAUDE} /> },
  google: {
    box: "0 0 18 18",
    draw: (
      <>
        <path
          fill="#4285f4"
          d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.87 2.69-6.62Z"
        />
        <path
          fill="#34a853"
          d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.8.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18Z"
        />
        <path
          fill="#fbbc05"
          d="M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3-2.33Z"
        />
        <path
          fill="#ea4335"
          d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A8.65 8.65 0 0 0 9 0 9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58Z"
        />
      </>
    ),
  },
  xai: {
    box: "0 0 24 24",
    draw: (
      <g fill="currentColor">
        <path d="M3 3h3.6l12.6 18h-3.6Z" />
        <path d="M17.6 3H21l-6.1 8.7-1.7-2.4Z" />
        <path d="M3 21h3.4l3.2-4.6-1.7-2.4Z" />
      </g>
    ),
  },
  mistral: {
    box: "0 0 20 20",
    draw: MISTRAL.flatMap(([fill, cells], row) =>
      cells.map((column) => (
        <rect key={`${fill}-${column}`} x={column * 4} y={row * 4} width="4" height="4" fill={fill} />
      )),
    ),
  },
  deepseek: {
    box: "0 0 24 24",
    draw: (
      <>
        <path
          fill="#4d6bfe"
          d="M2 12.5C2 8 5.8 5 10.6 5c3.2 0 5.7 1.3 7.2 3.4l3.2-1.6-1.1 3.8c.7 1 1.1 1.8 1.1 2.9 0 4.1-4.3 6.5-9.4 6.5S2 17.2 2 12.5Z"
        />
        <circle cx="15.6" cy="11.4" r="1.1" fill="#0f1012" />
      </>
    ),
  },
  groq: {
    box: "0 0 24 24",
    draw: (
      <>
        <circle cx="12" cy="12" r="11" fill="#f55036" />
        <circle cx="11.5" cy="10.5" r="3.6" fill="none" stroke="#fff" strokeWidth="2" />
        <path
          d="M15.1 10.5v3.6a3.6 3.6 0 0 1-6.3 2.4"
          fill="none"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </>
    ),
  },
  openrouter: {
    box: "0 0 24 24",
    draw: (
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12h4.5c3.5 0 4.5-6 8.5-6h4" />
        <path d="M2 12h4.5c3.5 0 4.5 6 8.5 6h4" />
        <path d="m17 3.5 2.5 2.5-2.5 2.5" />
        <path d="m17 15.5 2.5 2.5-2.5 2.5" />
      </g>
    ),
  },
  github: { box: "0 0 16 16", draw: <path fill="currentColor" d={GITHUB} /> },
};

/** The marks only agents and connections wear. */
type AgentMarkName = "opencode" | "linear" | "armada";
const AGENT_DRAWN: Record<AgentMarkName, { box: string; draw: ReactNode }> = {
  opencode: {
    box: "0 0 24 24",
    draw: <path fill="currentColor" fillRule="evenodd" d="M4 2h16v20H4Zm4 4v12h8V6Z" />,
  },
  linear: { box: "0 0 100 100", draw: <path fill="currentColor" d={LINEAR} /> },
  armada: {
    box: "0 0 32 32",
    draw: ARMADA.map((s) => <path key={s.d} d={s.d} fill={s.fill} fillOpacity={s.opacity} />),
  },
};
/** The catalog's `mark` (its plugin's id) to the maker's mark: Codex wears OpenAI's, Claude Anthropic's. */
const AGENT_MARKS: Record<string, MarkName | AgentMarkName> = {
  codex: "openai",
  claude: "anthropic",
  opencode: "opencode",
  linear: "linear",
  github: "github",
  armada: "armada",
};

/** An agent's or a connection's mark by the catalog's `mark`, decorative: its name says it. */
export function Mark({ mark, className }: { mark: string; className?: string }) {
  const name = AGENT_MARKS[mark] ?? "generic";
  const classes = cn("size-4 flex-none text-text", className);
  if (name === "generic") return <Sparkle aria-hidden data-mark="generic" className={classes} strokeWidth={1.75} />;
  const { box, draw } =
    name in AGENT_DRAWN ? AGENT_DRAWN[name as AgentMarkName] : DRAWN[name as Exclude<MarkName, "generic">];
  return (
    <svg aria-hidden data-mark={name} viewBox={box} preserveAspectRatio="xMidYMid meet" className={classes}>
      {draw}
    </svg>
  );
}

/** A provider's mark by its id (`openai-codex` wears OpenAI's), decorative: its name says it. */
export function ProviderMark({ provider, className }: { provider: string; className?: string }) {
  const name = markOf(provider);
  const classes = cn("size-4 flex-none text-text", className);
  if (name === "generic") return <Sparkle aria-hidden data-mark="generic" className={classes} strokeWidth={1.75} />;
  const { box, draw } = DRAWN[name];
  return (
    <svg aria-hidden data-mark={name} viewBox={box} preserveAspectRatio="xMidYMid meet" className={classes}>
      {draw}
    </svg>
  );
}
