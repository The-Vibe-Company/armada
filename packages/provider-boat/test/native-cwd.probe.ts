// Manual loopback HTTPS/Python bridge diagnostic; never part of Boat staging/release acceptance.
// Explicit command: bun test ./packages/provider-boat/test/native-cwd.probe.ts
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeCwdCommand } from "../src/native-cwd.ts";

test("Boat external subscription bridge consumes refresh RPC privately and completes the same native turn", async () => {
  const home = mkdtempSync(join(tmpdir(), "armada-boat-access-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const cert = join(home, "cert.pem"),
      key = join(home, "key.pem");
    const generated = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    expect(generated.status).toBe(0);
    const revisions: unknown[] = [];
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(key), cert: Bun.file(cert) },
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer private-guest-capability");
        const body = (await request.json()) as { previousRevision?: number };
        revisions.push(body.previousRevision ?? null);
        return Response.json({
          accessToken: body.previousRevision === 0 ? "private-next-access" : "private-first-access",
          chatgptAccountId: "shared-account",
          chatgptPlanType: null,
          revision: body.previousRevision === 0 ? 1 : 0,
        });
      },
    });
    mkdirSync(join(home, ".armada"), { mode: 0o700 });
    writeFileSync(
      join(home, ".armada/model-access.json"),
      JSON.stringify({ url: `https://localhost:${server.port}/access`, capability: "private-guest-capability" }),
      { mode: 0o600 },
    );
    const path = join(home, "codex");
    writeFileSync(
      `${path}.armada-original`,
      `#!/usr/bin/python3
import json,sys
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='account/login/start':
  assert m['params']['type']=='chatgptAuthTokens' and m['params']['accessToken']=='private-first-access'
  print(json.dumps({'id':m['id'],'result':{'type':'chatgptAuthTokens'}}),flush=True)
 elif m.get('method')=='thread/start': print(json.dumps({'id':m['id'],'result':{'thread':{'id':'thread'}}}),flush=True)
 elif m.get('method')=='turn/start':
  print(json.dumps({'id':m['id'],'result':{'turn':{'id':'turn'}}}),flush=True)
  print(json.dumps({'id':'renew','method':'account/chatgptAuthTokens/refresh','params':{'reason':'unauthorized','previousAccountId':'shared-account'}}),flush=True)
 elif m.get('id')=='renew':
  assert m['result']['accessToken']=='private-next-access' and 'refreshToken' not in m['result']
  print(json.dumps({'method':'turn/completed','params':{'text':'renewed private-next-access private-guest-capability'}}),flush=True)
 else: print(json.dumps({'id':m.get('id'),'result':{}}),flush=True)
`,
      { mode: 0o755 },
    );
    writeFileSync(path, `#!/bin/sh\n${nativeCwdCommand(path, "codex")}\n`, { mode: 0o755 });
    child = Bun.spawn([path, "app-server"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", SSL_CERT_FILE: cert },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const pipe = child.stdin as import("bun").FileSink;
    pipe.write(
      '{"id":1,"method":"initialize","params":{}}\n{"id":2,"method":"thread/start","params":{}}\n{"id":3,"method":"turn/start","params":{"threadId":"thread"}}\n',
    );
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let output = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
      if (output.includes("turn/completed")) pipe.end();
    }
    expect(await child.exited).toBe(0);
    expect(output).toContain('"text": "renewed *** ***"');
    expect(output).not.toContain("private-");
    expect(output).not.toContain("account/chatgptAuthTokens/refresh");
    expect(revisions).toEqual([null, 0]);
  } finally {
    child?.kill();
    server?.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});
