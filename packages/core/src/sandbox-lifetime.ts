import { PROVIDER_LIMITS } from "./sandbox-provider.ts";

/** Leave time for the lifecycle worker to interrupt, preserve and checkpoint before hard provider exit. */
export const SANDBOX_STOP_MARGIN_SECONDS = 300;

/** Server-owned Modal extension reserve; never selected by the launch request. */
export const DEFAULT_SANDBOX_EXTENSION_HEADROOM_SECONDS = 3600;
/** Broad transport ceiling; the sandbox's provider may impose a lower bound. */
export const MAX_SANDBOX_EXTENSION_TTL_SECONDS =
  Math.max(...Object.values(PROVIDER_LIMITS).map((limit) => limit.maxTtlSeconds)) - SANDBOX_STOP_MARGIN_SECONDS;
