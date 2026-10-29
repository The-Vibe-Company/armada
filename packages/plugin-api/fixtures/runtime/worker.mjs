import { createInterface } from "node:readline";

if (process.stdin.isTTY && process.stdout.isTTY) {
  console.log("ARMADA_CONFORMANCE_TTY_READY");
} else {
  console.log("ARMADA_CONFORMANCE_NO_TTY");
  process.exit(2);
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line === "exit") {
    console.log("ARMADA_CONFORMANCE_EXIT");
    input.close();
    process.exit(0);
  }
  console.log(`ARMADA_CONFORMANCE_ACK:${line}`);
});
