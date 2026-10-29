/** Implemented only by host adapters; consumers receive Keychain, never this backend. */
export interface KeychainBackend {
  readonly storage: "os-keychain" | "file";
  read(service: string, account: string): Promise<string | null>;
  write(service: string, account: string, value: string): Promise<void>;
}
