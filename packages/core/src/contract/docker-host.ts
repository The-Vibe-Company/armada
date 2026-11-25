const DOCKER_HOST_VERSION_STATUSES = ["unknown", "current", "outdated", "ahead"] as const;
export type DockerHostVersionStatus = (typeof DOCKER_HOST_VERSION_STATUSES)[number];

export function isDockerHostVersionStatus(value: unknown): value is DockerHostVersionStatus {
  return DOCKER_HOST_VERSION_STATUSES.some((status) => status === value);
}

export type DockerHostUpdatePolicy = "automatic" | "manual" | "pinned";
export const DOCKER_HOST_UPDATE_HEALTH_HEADER = "x-armada-docker-host-update-health";
export const DOCKER_HOST_UPDATE_RESULT_HEADER = "x-armada-docker-host-update-result";
export const dockerHostReleasePattern = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

export function isDockerHostUpdatePolicy(value: unknown): value is DockerHostUpdatePolicy {
  return value === "automatic" || value === "manual" || value === "pinned";
}

export interface DockerHostUpdateResult {
  version: string;
  status: "updated" | "failed";
  at: string;
  detail: "download_failed" | "startup_failed" | null;
}

export function isDockerHostUpdateResult(value: unknown): value is DockerHostUpdateResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<DockerHostUpdateResult>;
  return (
    typeof result.version === "string" &&
    dockerHostReleasePattern.test(result.version) &&
    (result.status === "updated" || result.status === "failed") &&
    typeof result.at === "string" &&
    Number.isFinite(Date.parse(result.at)) &&
    (result.detail === null ||
      (result.status === "failed" && (result.detail === "download_failed" || result.detail === "startup_failed")))
  );
}

export function parseDockerHostUpdateReport(header: string | null) {
  if (!header || header.length > 96) return undefined;
  const [version, status, time, detail = null, extra] = header.split(";");
  const at = time === undefined ? null : new Date(Number(time));
  if (extra !== undefined || (at && (!/^\d{1,15}$/.test(time ?? "") || !Number.isFinite(at.getTime()))))
    return undefined;
  const report = { version, status, at: at?.toISOString() ?? new Date(0).toISOString(), detail };
  return isDockerHostUpdateResult(report) ? { ...report, at: at?.toISOString() ?? null } : undefined;
}
