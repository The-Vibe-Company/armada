export const ANTIGRAVITY_ARTIFACT = {
  version: "1.5.13",
  x64: {
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/linux-x64/cli_linux_x64.tar.gz",
    archive: {
      bytes: 100548668,
      sha256: "7fa9cc6df0d09562693d637c406a86c1b0f52ab3364714b1fd2d79cc6060d4b2",
    },
    executable: {
      bytes: 270103240,
      sha256: "c3fd2c848abf88a243936f33e25bf5970802a7651840b5199318fcd8eb3fdb65",
    },
  },
  arm64: {
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/linux-arm/cli_linux_arm64.tar.gz",
    archive: {
      bytes: 91596782,
      sha256: "36596ad8038531fd75f0e97b5ba8967a30f2fd67f8d9c61959d2e4761d7b215f",
    },
    executable: {
      bytes: 253711024,
      sha256: "235147bb0b58673c6c8d130baab9c220921607220b7b0164dda27dd5e1c97cff",
    },
  },
} as const;
