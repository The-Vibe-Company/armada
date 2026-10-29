import { createInterface } from "node:readline";

// The I/O protocol works with a provider's PTY or a headless reference transport.
console.log("ARMADA_CONFORMANCE_READY");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line === "exit") {
    console.log("ARMADA_CONFORMANCE_EXIT");
    input.close();
    process.exit(0);
  }
  console.log(`ARMADA_CONFORMANCE_ACK:${line}`);
});
