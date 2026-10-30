import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import type { AuthInteraction, AuthPrompt } from "./connection.js";

/** Status probes never expose command output in errors. */
export function probe(
  binary: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<{ ok: boolean; missing: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      binary,
      [...args],
      { encoding: "utf8", timeout: 5000, maxBuffer: 65536, signal },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT",
          output: `${stdout ?? ""}\n${stderr ?? ""}`.trim(),
        });
      },
    );
  });
}
export async function installation(binary: string, signal?: AbortSignal) {
  const result = await probe(binary, ["--version"], signal);
  signal?.throwIfAborted();
  return {
    installed: !result.missing,
    ...(result.output.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.-]+)?\b/)?.[0]
      ? { version: result.output.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.-]+)?\b/)![0] }
      : {}),
  };
}

/** Strip credential-shaped output and email everywhere except explicit account labels. */
export function publicUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    url.username = "";
    url.password = "";
    for (const name of [...url.searchParams.keys()])
      if (
        /token|secret|password|key|email|login_hint|^(?:code|authorization_code|assertion|client_assertion)$/i.test(
          name,
        )
      )
        url.searchParams.delete(name);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function publicText(text: string, secrets: readonly string[] = [], account = false): string {
  let safe = text;
  for (const secret of secrets) if (secret) safe = safe.split(secret).join("[redacted]");
  return stripVTControlCharacters(safe)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => (account ? email : "[account]"))
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|lin_api_)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/https?:\/\/[^\s<>"')]+/g, (url) => publicUrl(url) ?? "[link removed]")
    .replace(
      /((?:access[_ -]?token|refresh[_ -]?token|id[_ -]?token|api[_ -]?key|authorization|password)\s*[=:]\s*)[^\s,}]+/gi,
      "$1[redacted]",
    );
}

/** Piped CLI login: output stays ephemeral; shell invocation and browser opening are disabled. */
export function loginCommand(binary: string, args: readonly string[], interaction: AuthInteraction): Promise<void> {
  return new Promise((resolve, reject) => {
    interaction.signal?.throwIfAborted();
    const child = spawn(binary, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        BROWSER: process.platform === "win32" ? "echo" : "true",
        GH_BROWSER: "true",
        NO_COLOR: "1",
      },
      windowsHide: true,
    });
    const entered: string[] = [];
    const buffers = { out: "", err: "" };
    const displays = { out: "", err: "" };
    const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
    let finished = false;
    let prompting = false;
    const promptController = new AbortController();
    const seenUrls = new Set<string>();
    const emit = (raw: string) => {
      const safe = publicText(raw, entered);
      for (const url of safe.match(/https?:\/\/[^\s<>"')]+/g) ?? []) {
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          interaction.notify({ type: "auth_url", url });
        }
      }
      const code = safe.match(/(?:one.time code|device code|code)\s*[:-]?\s*([A-Z0-9]{4}[- ][A-Z0-9]{4})\b/i)?.[1];
      if (code)
        interaction.notify({
          type: "device_code",
          userCode: code,
          verificationUri: [...seenUrls].find((url) => /device/.test(url)) ?? "https://github.com/login/device",
        });
      interaction.notify({ type: "terminal", output: safe });
    };
    const ask = (prompt: AuthPrompt, submit: (answer: string) => void | Promise<void>) => {
      if (prompting || finished) return;
      prompting = true;
      void interaction
        .prompt(prompt)
        .then(async (answer) => {
          if (finished || interaction.signal?.aborted) return;
          entered.push(answer);
          displays.out = "";
          displays.err = "";
          await submit(answer);
        })
        .catch(() => abort())
        .finally(() => {
          prompting = false;
        });
    };
    const input = (line: string) => {
      if (/press\s+enter/i.test(line)) {
        child.stdin.write("\n");
        return;
      }
      const choices = [...line.matchAll(/\b(\d+)\)\s*([^\r\n]+)/g)].map((m) => ({
        id: m[1]!,
        label: publicText(m[2]!, entered),
      }));
      const type = choices.length
        ? "select"
        : /token|password|api.?key/i.test(line)
          ? "secret"
          : /code/i.test(line)
            ? "manual_code"
            : "text";
      const message = publicText(line, entered).trim().slice(-500) || "Continue sign-in";
      ask(
        type === "select"
          ? { type, message, options: choices, signal: promptController.signal }
          : { type, message, signal: promptController.signal },
        (answer) => {
          child.stdin.write(`${answer}\n`);
        },
      );
    };
    const nativePrompt = (key: "out" | "err") => {
      if (prompting || finished) return;
      const display = publicText(displays[key], entered);
      const start = display.lastIndexOf("◆");
      if (start < 0 || display.lastIndexOf("◇") > start) return;
      const frame = display.slice(start).trimEnd();
      if (!/└[^\n]*$/.test(frame)) return;
      const message = frame.split(/\r?\n/)[0]!.replace(/^◆\s*/, "").trim().slice(0, 500);
      const rows = [...frame.matchAll(/^[\s│]*([●○])\s+([^\r\n]+)/gm)];
      if (rows.length) {
        const options = rows.map((row, index) => ({ id: String(index), label: row[2]!.trim() }));
        const current = Math.max(
          0,
          rows.findIndex((row) => row[1] === "●"),
        );
        const searchable = /Type: to search/.test(frame);
        if (searchable) options.push({ id: "search", label: "Search providers" });
        ask({ type: "select", message, options, signal: promptController.signal }, async (answer) => {
          if (answer === "search" && searchable) {
            const query = await interaction.prompt({
              type: "text",
              message: "Search providers",
              signal: promptController.signal,
            });
            entered.push(query);
            if (!finished && !interaction.signal?.aborted) child.stdin.write(query);
            return;
          }
          const selected = options.findIndex((option) => option.id === answer);
          if (selected < 0 || selected >= rows.length) throw new Error("Invalid provider choice");
          const distance = selected - current;
          child.stdin.write(`${(distance < 0 ? "\x1b[A" : "\x1b[B").repeat(Math.abs(distance))}\r`);
        });
      } else {
        const type = /token|password|api.?key/i.test(message)
          ? "secret"
          : /code/i.test(message)
            ? "manual_code"
            : "text";
        ask({ type, message, signal: promptController.signal }, (answer) => {
          child.stdin.write(`${answer}\r`);
        });
      }
    };
    const consume = (key: "out" | "err", chunk: Buffer) => {
      const decoded = decoders[key].write(chunk);
      buffers[key] += decoded;
      displays[key] = (displays[key] + decoded).slice(-65536);
      nativePrompt(key);
      let index = buffers[key].indexOf("\n");
      while (index >= 0) {
        const line = buffers[key].slice(0, index + 1);
        buffers[key] = buffers[key].slice(index + 1);
        emit(line);
        index = buffers[key].indexOf("\n");
        if (/\?\s*$|press\s+enter|(?:enter|paste|select|choose|press).*[:>]\s*$/i.test(line.trim())) input(line);
      }
      // Prompts often have no newline. Buffer everything else so split secrets cannot escape.
      if (/(?:enter|paste|select|choose|press)[^\n]*[:>?]\s*$/i.test(buffers[key])) {
        const line = buffers[key];
        buffers[key] = "";
        emit(line);
        input(line);
      }
      if (buffers[key].length > 65536) {
        buffers[key] = "";
        abort();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        consume("out", chunk);
      } catch {
        abort();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        consume("err", chunk);
      } catch {
        abort();
      }
    });
    child.stdin.on("error", () => {});
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (finished) return;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    interaction.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 10 * 60_000);
    timeout.unref();
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      promptController.abort();
      clearTimeout(timeout);
      clearTimeout(killTimer);
      interaction.signal?.removeEventListener("abort", abort);
      try {
        for (const value of Object.values(buffers)) if (value) emit(value);
      } catch {
        ok = false;
      }
      if (ok && !interaction.signal?.aborted) resolve();
      else reject(new Error("Provider sign-in did not complete"));
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}
