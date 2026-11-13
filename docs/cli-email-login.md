# CLI email login: code or link

The CLI requests email login with `cli_email_link: true`. Other API clients,
including iOS, omit this optional boolean and retain the code-only
`/login?flow=code` redirect. No migration or new secret is required.

The CLI binds an ephemeral HTTP listener on `127.0.0.1` and requests a
`/callback` redirect containing its random state. A link can complete login
only on the same machine, while that CLI process remains open. The callback
accepts a matching state and authorization code; the CLI exchanges that code
with the original PKCE verifier through Armada. It never accepts token
fragments, browser cookies or sessions relayed from a browser.

Users can instead type the numeric email code. The first successful path
wins and cancels the other input. Do not use both: consuming the email link
may consume the numeric code too. A rejected typed code ends the attempt with the existing code-refusal guidance;
request a fresh email if it was already consumed. A rejected callback does not
end the numeric-code attempt.

## Operator prerequisites (must be checked per deployment)

- Verify the identity provider's redirect allowlist permits the CLI's dynamic
  loopback port and `/callback?state=...` URL. Do not broaden it to arbitrary
  remote origins. Check the provider's wildcard rules before changing it.
- Verify the sign-in email template preserves the provider confirmation URL,
  the supplied redirect and PKCE flow, and includes the numeric code as a
  fallback. A custom template that discards the supplied redirect cannot
  complete the CLI link flow.
- If the provider falls back to the dashboard or the link cannot reach the
  local machine, enter the numeric code without opening the link first.
  Link completion is not claimed until the configured deployment has been
  checked; these changes do not modify allowlists/templates or deploy them.

Never paste callback codes, tokens or emailed sign-in URLs into logs or bug
reports. Closing the CLI invalidates that local attempt; start login again.
