import { decodeApiResponse } from "./api-responses.ts";
import { type ArmadaApiIo, createSdkCommandClient } from "./sdk-session.ts";

interface ArmadaApiOptions {
  url?: string;
  preserveServerErrors?: boolean;
}

export type ArmadaCommandClient = Awaited<ReturnType<typeof createSdkCommandClient>>;

export function createArmadaApiClient(io: ArmadaApiIo, options: ArmadaApiOptions = {}) {
  return createSdkCommandClient(
    io,
    (result, path, url, environmentToken) =>
      decodeApiResponse(result, path, url, environmentToken, options.preserveServerErrors),
    options,
  );
}
