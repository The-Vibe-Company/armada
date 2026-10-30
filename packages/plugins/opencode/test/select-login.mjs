#!/usr/bin/env node
// The native CLI's clack-style provider/method/password frames, under pipe I/O.
import { writeFileSync } from "node:fs";

let step = 0;
process.stdout.write(
  "\x1b[?25l◆  Select provider\n│  ● OpenCode (recommended)\n│  ○ OpenAI\n│  ↑/↓ to select • Enter: confirm • Type: to search\n└\n",
);
process.stdin.on("data", (value) => {
  const input = String(value);
  if (step < 2) {
    if (input !== "\x1b[B\r") process.exit(3);
    step++;
    process.stdout.write(
      step === 1
        ? "◇  Select provider\n◆  Login method\n│  ● ChatGPT\n│  ○ API key\n└\n"
        : "◇  Login method\n◆  Enter your API key\n│  _\n└\n",
    );
  } else {
    writeFileSync(process.env.ARMADA_OPENCODE_TEST_STATE, input.trim());
    console.log("◇  Connected");
    process.exit(0);
  }
});
