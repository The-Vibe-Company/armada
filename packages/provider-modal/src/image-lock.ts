/** Coordinator-approved Linux amd64 image/package lock. Resolved against the official Node
 * Docker Hub manifest and verified by apt policy in a real disposable Modal probe (terminated).
 * This is non-secret deployment configuration, not an account/profile identity. */
export const MODAL_IMAGE_LOCK = {
  base: "docker.io/library/node@sha256:aaa4b5baf1ecff3b283486bb1f90405cdda225a3e6f79660d2c559fa510a7292",
  apt: {
    git: "1:2.39.5-0+deb12u3",
    gh: "2.23.0+dfsg1-1",
    opensshServer: "1:9.2p1-2+deb12u10",
    sudo: "1.9.13p3-1+deb12u4",
    caCertificates: "20250419~deb12u2",
    curl: "7.88.1-10+deb12u15",
    unzip: "6.0-28+deb12u1",
  },
} as const;

/** Non-secret disposable-conformance App binding approved by the coordinator. AppID, not
 * the local SDK profile label, is authoritative. Workspace metadata comes from trusted DB. */
export const MODAL_CONFORMANCE_APP = {
  appName: "armada-provider-conformance",
  appId: "ap-MQmau5HWSdX2t036SWIP7A",
  environment: "main",
} as const;
