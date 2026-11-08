import pkg from "../package.json" with { type: "json" };

/** The one Armada version: every package and the compiled `armada` binary report it. */
export const VERSION: string = pkg.version;
