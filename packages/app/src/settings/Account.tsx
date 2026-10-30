import type { AccountDevice, AccountState } from "@armada/protocol";
import { type ReactNode, useEffect, useId, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { openExternal } from "@/lib/external";
import { useDaemon, useDaemonClient } from "@/protocol/store";
import { SettingsRow, SettingsSection, StateDot } from "./Layout";

type SignedIn = Extract<AccountState, { signedIn: true }>;

const EXPIRED = "The code expired";
const PROVIDED = { word: "Provided", dot: "bg-green", ink: "text-text-2" };
const NOT_PROVIDED = { word: "Not provided", dot: "bg-text-3", ink: "text-text-3" };

/**
 * The sign-ins this app started, kept beside the section (it unmounts with
 * each other section, and a sign-in outlives that): the latest one, whether it
 * is waiting, the latest one cancelled, the code whose page already opened,
 * and how the latest one failed.
 */
interface Sign {
  attempt: number;
  waiting: boolean;
  cancelled: number;
  opened: string | null;
  failure: string | null;
}
let sign: Sign = { attempt: 0, waiting: false, cancelled: 0, opened: null, failure: null };
const watchers = new Set<() => void>();
function setSign(next: Partial<Sign>) {
  sign = { ...sign, ...next };
  for (const watch of watchers) watch();
}
const watchSign = (watch: () => void) => {
  watchers.add(watch);
  return () => watchers.delete(watch);
};
const readSign = () => sign;

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
  const flow = useSyncExternalStore(watchSign, readSign, readSign);
  const [signingOut, setSigningOut] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [outFailure, setOutFailure] = useState<string | null>(null);
  const warning = useId();

  // The verification page opens once per code, as `armada login` opens it, and not again on coming back here.
  useEffect(() => {
    if (!accountDevice || sign.cancelled === sign.attempt || sign.opened === accountDevice.code) return;
    setSign({ opened: accountDevice.code });
    openExternal(accountDevice.verificationUrl);
  }, [accountDevice]);

  async function signIn() {
    const attempt = sign.attempt + 1;
    setSign({ attempt, waiting: true, opened: null, failure: null });
    try {
      await client.login();
      if (attempt === sign.attempt) setSign({ waiting: false });
    } catch (error) {
      // A cancelled or superseded sign-in's end is not news: the account the daemon publishes is.
      if (attempt === sign.attempt && sign.cancelled !== attempt)
        setSign({
          waiting: false,
          failure: (error as { code?: string }).code === "expired" ? EXPIRED : lineOf(error),
        });
    }
  }

  // Cancel stops waiting here and sends nothing. `account.logout` would also
  // clear what the CLI keeps (an API key, a session for another address), so
  // Sign out is its only path. The daemon's code stays valid until it expires;
  // Sign in again joins it.
  function cancel() {
    setSign({ cancelled: sign.attempt, waiting: false });
  }

  async function signOut() {
    setConfirming(false);
    setOutFailure(null);
    setSigningOut(true);
    try {
      await client.logout();
    } catch (error) {
      setOutFailure(lineOf(error));
    } finally {
      setSigningOut(false);
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

  // The daemon holds the code while its login is pending: coming back to this section mid-way shows it again.
  const signingIn = flow.waiting || (accountDevice !== null && flow.cancelled !== flow.attempt);
  const failure = account.signedIn ? outFailure : flow.failure;
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
                {confirming && (
                  <p id={warning} role="status" data-confirm className="m-0 pt-1 text-text-2">
                    This signs out the CLI on this device too.
                  </p>
                )}
                {problem}
              </>
            }
            control={
              confirming ? (
                <>
                  <Button variant="ghost" onClick={() => setConfirming(false)}>
                    Keep
                  </Button>
                  <Button aria-describedby={warning} onClick={() => void signOut()}>
                    Sign out
                  </Button>
                </>
              ) : (
                <Button disabled={signingOut} onClick={() => setConfirming(true)}>
                  {signingOut ? "Signing out…" : "Sign out"}
                </Button>
              )
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
                <Button onClick={cancel}>Cancel</Button>
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
