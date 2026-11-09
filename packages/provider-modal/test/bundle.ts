// Compile and run without workspace runtime files: actual runtime JS is embedded into the executable.

import { loadEmbeddedRunnerArtifact } from "../src/embedded.ts";
import { createComposedModalProvider } from "../src/index.ts";

const artifact = await loadEmbeddedRunnerArtifact();
if (artifact.bundle.length < 1000) throw Error("missing embedded runtime");
console.log(typeof createComposedModalProvider, artifact.bundle.length);
