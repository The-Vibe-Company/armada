/** Installed server image metadata, never a client-controlled path. Native
 * rollback must boot even when runtime-only artifacts are missing/corrupt. */
export async function readBoatRuntimeManifest(path: string, mode: "native" | "runtime") {
  try {
    const row = await Bun.file(path).json();
    if (
      row?.protocol !== 1 ||
      row.platform !== "linux" ||
      row.libc !== "glibc" ||
      !["x64", "arm64"].includes(row.architecture) ||
      typeof row.runtime?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.runtime.sha256) ||
      !Number.isSafeInteger(row.runtime.bytes) ||
      row.runtime.bytes < 1 ||
      row.runtime.bytes > 512 * 1024 * 1024
    )
      throw Error();
    return { manifest: row as unknown, architecture: row.architecture as "x64" | "arm64" };
  } catch {
    if (mode === "runtime")
      throw Error("Boat runtime default requires valid installed runtime artifacts; no native fallback.");
    return undefined;
  }
}
