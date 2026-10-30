import type { AccountDevice, AccountState } from "@armada/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { openExternal } from "@/lib/external";
import { useDaemon, useDaemonClient } from "@/protocol/store";
import { SettingsRow, SettingsSection, StateDot } from "./Layout";

type SignedIn = Extract<AccountState, { signedIn: true }>;

const EXPIRED = "The code expired";
const PROVIDED = { word: "Provided", dot: "bg-green", ink: "text-text-2" };
const NOT_PROVIDED = { word: "Not provided", dot: "bg-text-3", ink: "text-text-3" };

/**
 * Settings' Account (THE-2071): the sign-in `armada login` does, run by the
 * daemon (THE-2068's `account.*`) and kept on this device, so the app and the
 * CLI share it. Signed out, one Sign in; signing in, the device code large, the
 * verification page opened in the system browser and a wait for its approval;
 * signed in, who and which organization, then what Armada provides: its keys
 * and its projects. The session token never reaches the app.
 */
export function Account() {
  const { account, accountDevice, accountProblem, projects } = useDaemon();
  const client = useDaemonClient();
  const [busy, setBusy] = useState<"login" | "logout" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Cancel has no request of its own: the daemon's `account.logout` aborts a
  // pending sign-in (nothing is stored before approval, so it signs nobody
  // out). The login then fails with the daemon's line; this says to ignore it.
  const cancelled = useRef(false);

  // The verification page opens once per code, as `armada login` opens it.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!accountDevice || opened.current === accountDevice.code) return;
    opened.current = accountDevice.code;
    openExternal(accountDevice.verificationUrl);
  }, [accountDevice]);

  async function signIn() {
    cancelled.current = false;
    setFailure(null);
    setBusy("login");
    try {
      await client.login();
    } catch (error) {
      if (!cancelled.current) setFailure((error as { code?: string }).code === "expired" ? EXPIRED : lineOf(error));
    } finally {
      setBusy(null);
    }
  }

  async function signOut(cancel: boolean) {
    cancelled.current = cancel;
    setFailure(null);
    if (!cancel) setBusy("logout");
    try {
      await client.logout();
    } catch (error) {
      setFailure(lineOf(error));
    } finally {
      if (!cancel) setBusy(null);
    }
  }

  if (!account)
    return (
      <SettingsSection title="Armada">
        <SettingsRow
          title="Account"
          description="Workers in Conductor and the organization's keys need it."
          status={<span className="text-text-3">{accountProblem ?? "Reading the sign-in…"}</span>}
          control={<Button disabled>Sign in</Button>}
        />
      </SettingsSection>
    );

  const signingIn = busy === "login";
  const problem = failure && (
    <p role="alert" className="m-0 pt-1 text-red">
      {failure}
    </p>
  );
  return (
    <>
      <SettingsSection title="Armada">
        {account.signedIn ? (
          <SettingsRow
            title="Account"
            description={<span className="text-text">{account.email}</span>}
            status={
              <>
                <span data-organization className="text-text-2">
                  {account.organization.name}
                </span>
                {problem}
              </>
            }
            control={
              <Button disabled={busy !== null} onClick={() => void signOut(false)}>
                {busy === "logout" ? "Signing out…" : "Sign out"}
              </Button>
            }
          />
        ) : (
          <SettingsRow
            title="Account"
            description={
              signingIn
                ? "Enter this code on Armada's device page, then approve this device."
                : "Workers in Conductor and the organization's keys need it."
            }
            status={!signingIn && problem}
            control={
              signingIn ? (
                <Button onClick={() => void signOut(true)}>Cancel</Button>
              ) : (
                <Button variant="primary" onClick={() => void signIn()}>
                  {failure === EXPIRED ? "Sign in again" : "Sign in"}
                </Button>
              )
            }
          >
            {signingIn && <DeviceCode device={accountDevice} />}
          </SettingsRow>
        )}
        <SettingsRow
          title="Server"
          description="The Armada this device signs in to."
          control={<Value>{account.apiUrl}</Value>}
        />
      </SettingsSection>
      {account.signedIn && <FromArmada account={account} local={projects?.map((p) => p.id) ?? []} />}
    </>
  );
}

/** The code to enter, its page in the browser (and copyable), and the wait for its approval. */
function DeviceCode({ device }: { device: AccountDevice | null }) {
  const [copied, setCopied] = useState(false);
  if (!device)
    return (
      <div className="pb-3">
        <Waiting>Asking Armada for a code…</Waiting>
      </div>
    );
  const url = device.verificationUrl;
  return (
    <div data-device className="flex flex-col items-start gap-3 pt-1 pb-3">
      <span data-code className="select-all font-mono text-title tracking-[0.08em]">
        {device.code}
      </span>
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
        <Button variant="soft" onClick={() => openExternal(url)}>
          Open {url.replace(/^https?:\/\//, "").replace(/[?#].*$/, "")}
        </Button>
        <span className="min-w-0 select-all break-all font-mono text-small text-text-2">{url}</span>
        <Button
          variant="ghost"
          onClick={() =>
            void navigator.clipboard?.writeText(url).then(
              () => setCopied(true),
              () => {},
            )
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Waiting>Waiting for approval…</Waiting>
    </div>
  );
}

function Waiting({ children }: { children: ReactNode }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-small text-text-2">
      <span aria-hidden className="waiting-pulse size-1.5 flex-none rounded-full bg-amber" />
      {children}
    </span>
  );
}

/** What the organization's Armada provides this device: its keys (never their values) and its projects. */
function FromArmada({ account, local }: { account: SignedIn; local: readonly string[] }) {
  return (
    <SettingsSection title="From Armada">
      <SettingsRow
        title="Linear"
        description="The organization's Linear key, for a project without its own."
        control={<StateDot {...(account.keys.linear ? PROVIDED : NOT_PROVIDED)} />}
        data-key="linear"
      />
      <SettingsRow
        title="GitHub"
        description="The organization's GitHub access, through the Armada GitHub App."
        control={<StateDot {...(account.keys.github ? PROVIDED : NOT_PROVIDED)} />}
        data-key="github"
      />
      {account.projects.length === 0 ? (
        <SettingsRow title="Projects" description={`${account.organization.name} has no project in Armada yet.`} />
      ) : (
        account.projects.map((project) => (
          <SettingsRow
            key={project.slug}
            data-project={project.slug}
            title={project.name}
            description={<span className="font-mono">{project.slug}</span>}
            control={
              local.includes(project.slug) ? (
                <StateDot
                  word="Linked"
                  dot="bg-green"
                  ink="text-text-2"
                  title="A project of this daemon has this slug"
                />
              ) : (
                <span className="text-small text-text-3">Not on this device</span>
              )
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

function Value({ children }: { children: ReactNode }) {
  return <span className="select-text break-all font-mono text-small text-text-soft">{children}</span>;
}

const lineOf = (error: unknown) => (error instanceof Error ? error.message : "Armada did not answer. Try again.");
