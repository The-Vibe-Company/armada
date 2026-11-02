import { existsSync, unlinkSync, watch } from "node:fs";
import { createInterface } from "node:readline";

const emit = (value) => console.log(JSON.stringify({ session_id: "claude-fixture-session", ...value }));
emit({ type: "system", subtype: "init" });
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const content = JSON.parse(line).message.content;
  emit({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
  const hold = content === "hold" || content.startsWith("# SEED-");
  if (hold) {
    const marker = ".fixture-complete";
    let watcher;
    let completed = false;
    const finish = () => {
      if (completed || !existsSync(marker)) return;
      completed = true;
      watcher?.close();
      unlinkSync(marker);
      emit({ type: "result", result: "reply:hold" });
    };
    watcher = watch(".", finish);
    finish();
  }
  if (content === "auth-error") emit({ type: "result", is_error: true, errors: ["Authentication unavailable"] });
  else if (!hold) emit({ type: "result", result: `reply:${content}` });
});
