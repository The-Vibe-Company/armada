import type { Configuration } from "electron-builder";
import { MAIN_OUTPUT, PACKAGED_APP_DIR, PACKAGED_ICON } from "./paths.ts";

export const APP_ID = "co.thevibecompany.armada";
export const PRODUCT_NAME = "Armada";
/** The hardened runtime's entitlements: a network client, no sandbox (THE-2229; signing itself is THE-2230). */
export const ENTITLEMENTS = "resources/entitlements.mac.plist";
/**
 * Any of these set turns macOS code signing on (the release workflow's certificate or Apple
 * account, THE-2230). Without them electron-builder is told `identity: null` and never
 * looks for a certificate: the DMG is unsigned, opened after `xattr -dr com.apple.quarantine`.
 */
export const SIGNING_VARIABLES = ["CSC_LINK", "CSC_NAME", "APPLE_ID", "APPLE_TEAM_ID"] as const;

export const signingRequested = (env: Record<string, string | undefined>): boolean =>
  SIGNING_VARIABLES.some((name) => (env[name] ?? "").trim() !== "");

/**
 * All three set turns notarisation on: electron-builder hands them to notarytool after signing.
 * Said explicitly because electron-builder 26 otherwise notarises whenever they exist and warns
 * on every build without them (the release workflow sets them only with a certificate, THE-2230).
 */
export const NOTARIZATION_VARIABLES = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"] as const;

export const notarizationRequested = (env: Record<string, string | undefined>): boolean =>
  NOTARIZATION_VARIABLES.every((name) => (env[name] ?? "").trim() !== "");

/** electron-builder's configuration (electron-builder.ts hands it `process.env`). */
export function packagingConfig(env: Record<string, string | undefined>): Configuration {
  return {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    directories: { output: "release", buildResources: "resources" },
    files: ["out/**/*", "package.json"],
    asar: true,
    // The keyring binding is a native addon; the daemon entry runs as a Node child outside the archive,
    // with the chunks it imports (electron-vite splits them between it and the shell's own entry).
    asarUnpack: ["node_modules/@napi-rs/keyring*/**", `${MAIN_OUTPUT}/**`],
    // The binding ships prebuilt for darwin-arm64; nothing to compile against Electron's headers.
    npmRebuild: false,
    extraResources: [
      { from: "../app/dist", to: PACKAGED_APP_DIR },
      { from: "resources/icon.png", to: PACKAGED_ICON },
    ],
    mac: {
      target: [
        { target: "dmg", arch: ["arm64"] },
        { target: "zip", arch: ["arm64"] },
      ],
      icon: "resources/icon.icns",
      category: "public.app-category.developer-tools",
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: ENTITLEMENTS,
      entitlementsInherit: ENTITLEMENTS,
      ...(signingRequested(env) ? {} : { identity: null }),
      notarize: notarizationRequested(env),
    },
    // The update feed (THE-2231); `dist` builds with `--publish never`, and the release workflow
    // attaches the dmg, the zip, latest-mac.yml and the blockmaps to the release itself (THE-2230).
    publish: { provider: "github", owner: "The-Vibe-Company", repo: "armada" },
  };
}
