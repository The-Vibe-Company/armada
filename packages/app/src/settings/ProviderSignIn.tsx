// One sign-in to a model provider (THE-2070), after T3 Code's
// ProviderAuthenticationSection (pingdotgg/t3code): started by a button, it
// renders the daemon's auth frames in place (the browser's page with Copy, a
// device code, progress, a question to answer) with Cancel, and a red line
// when it fails. What the owner types in a prompt lives only in its field
// until sent: never in state, and the field is cleared once sent.
import { Check, Copy, ExternalLink, LoaderCircle } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Input, Select } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useDaemon, useDaemonClient } from "@/protocol/store";
import { type AuthPrompt, applyAuthFrame, type SignInView, startSignIn } from "./models";

const NOT_SENT = "The answer was not sent: the daemon is not connected.";

/** Opens a page in the system browser: the desktop shell hands every `window.open` to it. */
function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

export interface SignIn {
  view: SignInView | null;
  /** A sign-in is shown, or the daemon has not ended the last one yet (a cancel it has not confirmed). */
  busy: boolean;
  start(provider: string): void;
  cancel(): void;
  close(): void;
  answer(prompt: AuthPrompt, value: string): void;
}

/**
 * The one sign-in of the Coordinator section: its view from the daemon's
 * frames, the browser opened once per page it names, and the flow cancelled
 * when the section leaves the screen. Each start is a generation: the end of
 * an earlier one (its late refusal after a cancel) never reaches a later one.
 */
export function useSignIn(): SignIn {
  const client = useDaemonClient();
  const { authFlow } = useDaemon();
  const [view, setView] = useState<SignInView | null>(null);
  const generation = useRef(0);
  const opened = useRef<string | null>(null);
  const active = useRef(false);
  useEffect(() => {
    const off = client.auth((frame) => setView((current) => (current ? applyAuthFrame(current, frame) : current)));
    return () => {
      off();
      if (active.current) void client.cancel().catch(() => {});
    };
  }, [client]);
  const url = view?.url ?? null;
  useEffect(() => {
    if (url && opened.current !== url) {
      opened.current = url;
      openExternal(url);
    }
  }, [url]);
  return {
    view,
    busy: view !== null || authFlow !== null,
    start(provider) {
      const mine = ++generation.current;
      opened.current = null;
      active.current = true;
      setView(startSignIn(provider));
      client.login(provider, "oauth").then(
        () => {
          if (generation.current !== mine) return;
          active.current = false;
          setView(null);
        },
        (error: unknown) => {
          if (generation.current !== mine) return;
          active.current = false;
          const message = error instanceof Error && error.message ? error.message : "Sign-in failed. Try again.";
          setView((current) => current && { ...current, prompt: null, error: message });
        },
      );
    },
    cancel() {
      // The owner's cancel: whatever the daemon says of this flow from now on is not shown.
      generation.current++;
      active.current = false;
      void client.cancel().catch(() => {});
      setView(null);
    },
    close() {
      setView(null);
    },
    answer(prompt, value) {
      const flow = client.getState().authFlow;
      if (!flow) return;
      try {
        client.answer(flow, prompt.id, value);
        setView((current) => current && { ...current, prompt: null });
      } catch (error) {
        setView((current) => current && { ...current, error: error instanceof Error ? error.message : NOT_SENT });
      }
    },
  };
}

/** The sign-in in place, under the button that started it. */
export function SignInPanel({ signIn, name }: { signIn: SignIn; name: string }) {
  const view = signIn.view;
  if (!view) return null;
  const waiting = !view.url && !view.device && !view.prompt && !view.error && view.lines.length === 0;
  return (
    <section
      data-sign-in={view.provider}
      aria-label={`Sign in to ${name}`}
      className="flex min-w-0 flex-col gap-3 rounded-control bg-sunken p-3.5 shadow-ring"
    >
      {waiting && <Line busy>Opening your browser…</Line>}
      {view.url && (
        <div className="flex min-w-0 flex-col gap-2">
          <Line busy={!view.prompt && !view.error}>
            {view.instructions ?? "Continue in your browser. If it did not open, open this page:"}
          </Line>
          <div className="flex min-w-0 items-center gap-2">
            <a
              href={view.url}
              target="_blank"
              rel="noopener noreferrer"
              data-auth-url
              className="min-w-0 flex-1 select-text truncate font-mono text-small text-blue hover:underline"
            >
              {view.url}
            </a>
            <CopyButton text={view.url} label="Copy link" />
          </div>
        </div>
      )}
      {view.device && (
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-small text-text-2">Enter this code on the sign-in page:</span>
          <div className="flex flex-wrap items-center gap-3">
            <span data-device-code className="select-text font-mono text-hero text-text tracking-[0.12em]">
              {view.device.code}
            </span>
            <CopyButton text={view.device.code} label="Copy code" />
          </div>
          <a
            href={view.device.uri}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-small text-blue hover:underline"
          >
            {view.device.uri}
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        </div>
      )}
      {view.lines.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {view.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: progress lines only grow, and may repeat.
            <li key={index} className="text-small text-text-2">
              {line}
            </li>
          ))}
        </ul>
      )}
      {view.links.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {view.links.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-small text-blue hover:underline"
            >
              {link.label}
            </a>
          ))}
        </div>
      )}
      {view.prompt && <PromptForm key={view.prompt.id} prompt={view.prompt} onAnswer={signIn.answer} />}
      {view.error && (
        <p role="alert" className="m-0 text-red">
          {view.error}
        </p>
      )}
      <div className="flex items-center gap-2">
        {view.error ? (
          <>
            <Button variant="soft" onClick={() => signIn.start(view.provider)}>
              Try again
            </Button>
            <Button variant="ghost" onClick={signIn.close}>
              Close
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={signIn.cancel}>
            Cancel
          </Button>
        )}
      </div>
    </section>
  );
}

function Line({ busy, children }: { busy?: boolean; children: string }) {
  return (
    <p role="status" className="m-0 flex items-center gap-2 text-text-2">
      {busy && <LoaderCircle aria-hidden className="size-3.5 flex-none animate-spin motion-reduce:animate-none" />}
      <span>{children}</span>
    </p>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="soft"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => {});
      }}
    >
      {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** A question of the sign-in: text, a secret (masked), a choice, or the code the browser shows. */
function PromptForm({ prompt, onAnswer }: { prompt: AuthPrompt; onAnswer: SignIn["answer"] }) {
  const field = useId();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = String(new FormData(form).get("answer") ?? "");
    // Clear the field before sending: the answer never stays in the page.
    form.reset();
    onAnswer(prompt, value);
  }
  const choices = prompt.promptType === "select" ? (prompt.options ?? []) : null;
  return (
    <form onSubmit={submit} data-auth-prompt={prompt.promptType} className="m-0 flex min-w-0 flex-col gap-2">
      <label htmlFor={field} className="text-meta text-text">
        {prompt.message}
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {choices ? (
          <Select id={field} name="answer" required defaultValue={choices[0]?.id} className="min-w-48 flex-1">
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.description ? `${choice.label} — ${choice.description}` : choice.label}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            id={field}
            name="answer"
            required
            type={prompt.promptType === "secret" ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            maxLength={16384}
            placeholder={
              prompt.promptType === "manual_code" ? "Paste the code from the browser" : (prompt.placeholder ?? "")
            }
            className="min-w-48 flex-1"
          />
        )}
        <Button type="submit" variant="soft">
          Continue
        </Button>
      </div>
    </form>
  );
}
