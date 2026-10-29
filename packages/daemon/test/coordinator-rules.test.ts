import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Coordinators } from "../coordinator/index.ts";
import { fold } from "../src/fold.ts";
import { EventStore } from "../src/store.ts";

test("a chat-triggered V1 import leaves unrelated file content out of the durable conversation and log", async () => {
  const directory = mkdtempSync(join(tmpdir(), "armada-rules-chat-"));
  const file = join(directory, "armada.toml");
  const body = '[policy]\nmax_workers = 2\n[unrelated]\nmarker = "synthetic-file-only-note"\n';
  writeFileSync(file, body);
  const store = new EventStore(":memory:");
  const manager = new Coordinators(store);
  const faux = fauxProvider({ models: [{ id: "rules" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  let modelTranscript = "";
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("rules.set", { expectedRevision: 0, reason: "Import the owner's file", importFile: file })],
      { stopReason: "toolUse", timestamp: 0 },
    ),
    (transcript) => {
      modelTranscript = JSON.stringify(transcript.messages);
      return fauxAssistantMessage("Rules imported", { timestamp: 0 });
    },
  ]);
  try {
    const coordinator = await manager.open({
      project: "orchard",
      models,
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
      now: () => 0,
      setTimer: () => () => {},
    });
    const submission = await coordinator.conversation.submit(
      { type: "input", content: `Import rules from ${file}` },
      context,
    );
    assert.equal((await submission.wait(context)).status, "done");
    assert.equal(fold(store.readSince(0)).projects.orchard?.rules?.value.policy?.maxWorkers, 2);
    assert.ok(!modelTranscript.includes("synthetic-file-only-note"));
    assert.ok(!JSON.stringify(store.readSince(0)).includes("synthetic-file-only-note"));
  } finally {
    await manager.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
