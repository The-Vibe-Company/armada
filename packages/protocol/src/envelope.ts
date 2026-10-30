import { z } from "zod";

export const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const identifier = z.string().min(1);
export const versionSchema = z.object({ major: counter, minor: counter });
