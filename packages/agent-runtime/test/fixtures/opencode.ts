import { readFileSync } from "node:fs";

const command = process.argv[2];
if (command === "acp") await import("./acp.ts");
else if (command === "export")
  process.stdout.write(JSON.stringify({ info: { id: "session-1" }, messages: [{ text: "private-key-for-test" }] }));
else if (command === "import") {
  const saved = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
  if (
    saved.info.id !== "session-1" ||
    !Array.isArray(saved.messages) ||
    JSON.stringify(saved).includes("private-key-for-test")
  )
    process.exit(2);
} else process.exit(3);
