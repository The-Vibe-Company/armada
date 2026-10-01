// The CLI released from the commit this dashboard was built from: the latest
// an outdated CLI is told to install (`cli-api.ts`), and what the Fleet view
// compares each coordinator's CLI with. Never below the oldest CLI it serves.
import { MINIMUM_CLI_VERSION, versionToInstall } from "@armada/core/read";
import cliPackage from "../../cli/package.json" with { type: "json" };

export const LATEST_CLI_VERSION = versionToInstall(MINIMUM_CLI_VERSION, cliPackage.version);
