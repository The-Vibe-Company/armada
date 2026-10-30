// The owner's field, fixed at the bottom of the room (THE-1996): a labelled
// message and Send. The text stays in the field until the daemon admitted it;
// a failure says why under it and keeps it for another try (the same message).
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";

export function Composer({
  send,
  disabled,
  hint,
}: {
  send: (body: string) => Promise<void>;
  /** No coordinator, or no connection: the field says why below and sends nothing. */
  disabled: boolean;
  hint: string | null;
}) {
  const field = useId();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = body.trim();
    if (!text || sending || disabled) return;
    setSending(true);
    setProblem(null);
    try {
      await send(text);
      setBody((current) => (current.trim() === text ? "" : current));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The message was not sent. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Message the coordinator"
      className="flex flex-none flex-col gap-2 border-line border-t bg-bg px-3 pt-3 pb-3.5 sm:px-12 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-(--chat-content-max-width)"
    >
      <div className="flex items-center gap-3">
        <label htmlFor={`${field}-message`} className="w-16 flex-none text-body text-text-2">
          Message
        </label>
        <input
          id={`${field}-message`}
          type="text"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={16 * 1024}
          autoComplete="off"
          placeholder="Tell the coordinator…"
          aria-describedby={hint ? `${field}-hint` : undefined}
          disabled={disabled}
          className="h-10 min-w-0 flex-1 rounded-md bg-card px-3.5 text-sub text-text shadow-ring placeholder:text-text-3 disabled:opacity-60"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={disabled || sending || !body.trim()}
          className="h-10 px-4.5 text-sub"
        >
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
      {hint && (
        <p id={`${field}-hint`} className="m-0 pl-19 text-body text-text-3">
          {hint}
        </p>
      )}
      {problem && (
        <p role="alert" className="m-0 pl-19 text-body text-red">
          {problem}
        </p>
      )}
    </form>
  );
}
