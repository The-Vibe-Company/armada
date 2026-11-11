import manifest from "../../helper/manifest.json";

/** The verifier wire response for lifecycle fakes, not an installer/integrity oracle. */
export const goldenHelperReport = `x86_64\n${manifest.x86_64.digest}  /home/user/.local/share/armada/helper/0.1.0/armada-helper\n{"version":"0.1.0","protocol":1,"capabilities":["diagnose"]}\n`;
