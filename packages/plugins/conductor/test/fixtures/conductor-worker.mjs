#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
const path = new URL('./state.json', import.meta.url);
const state = JSON.parse(await readFile(path, 'utf8').catch(() => '{"calls":[],"status":"idle"}'));
const args = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
state.calls.push({ args, input });
let answer;
if (args[0] === 'workspace' && args[1] === 'create') {
  state.status = 'working';
  state.brief = input;
  state.name = args[args.indexOf('--name') + 1];
  state.sessionName = args[args.indexOf('--session-name') + 1];
  state.repoUrl = args[args.indexOf('--repo-url') + 1];
  answer = { workspaceId: state.echoCreateToken ? (state.tokenPrefix || '') + /^armada login --launch-token (\S+)/.exec(input)?.[1] : 'orchard-ws', sessionId: 'orchard-session' };
} else if (args[0] === 'workspace' && args[1] === 'list') {
  answer = { hasMore: false, data: state.brief ? [{ id: 'orchard-ws', name: state.name, repoUrl: state.repoUrl, state: state.archived ? 'archived' : 'ready' }] : [] };
} else if (args[0] === 'workspace' && args[1] === 'session') {
  answer = { hasMore: false, data: [{ id: 'orchard-session', name: state.sessionName }] };
} else if (args[0] === 'workspace' && args[1] === 'status') {
  answer = { workspaceId: args[2], status: state.archived ? 'archived' : 'ready' };
} else if (args[0] === 'session' && args[1] === 'status') {
  answer = { workspaceId: state.mismatch ? 'other' : 'orchard-ws', sessionId: args[2], status: state.status };
} else if (args[0] === 'message') {
  answer = { messageId: 'orchard-message', state: 'sent' };
} else if (args[0] === 'session' && args[1] === 'cancel') {
  state.status = 'idle';
  answer = { sessionId: args[2], status: 'idle' };
} else if (args[0] === 'workspace' && args[1] === 'archive') {
  state.archived = true;
  answer = { workspaceId: args[2], status: 'archived' };
} else throw new Error('Unsupported fixture operation');
await writeFile(path, JSON.stringify(state));
if (state.failCreate && args[1] === 'create') {
  process.stderr.write(state.brief);
  process.exitCode = 1;
} else process.stdout.write(JSON.stringify(answer));
