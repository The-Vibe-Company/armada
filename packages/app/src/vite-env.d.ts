/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ARMADA_DAEMON_URL?: string;
}

/** The app's version (package.json), set by vite.config.ts; absent outside Vite's build. */
declare const __ARMADA_APP_VERSION__: string | undefined;
