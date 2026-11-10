// External native install output. No Armada business handlers are replaced.
export const catalogReference = "example/notes@1.0.0";
export const catalogReceipt = {
  reference: catalogReference,
  version: "1.0.0",
  skillId: "11111111-1111-4111-8111-111111111111",
  checksum: `sha256:${"b".repeat(64)}`,
  origin: "https://skillpack.app/v1",
};
export function catalogLock(tool: "claude-code" | "codex"): string {
  return JSON.stringify({
    lockfileVersion: 2,
    workspaces: {
      "catalog:example": {
        apiUrl: catalogReceipt.origin,
        skills: {
          notes: {
            catalogReference: "example/notes",
            version: "1.0.0",
            pinned: "1.0.0",
            skillId: catalogReceipt.skillId,
            checksum: catalogReceipt.checksum,
            targets: [{ tool, version: "1.0.0", packageChecksum: catalogReceipt.checksum }],
          },
        },
      },
    },
  });
}
