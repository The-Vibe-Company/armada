# Armada sign-in email

Canonical subject: **Your Armada sign-in code and link**

Canonical body: [supabase/templates/magic-link.html](../supabase/templates/magic-link.html).
The local Supabase template mapping lives in [config.toml](../supabase/config.toml).
The code is Supabase's one-time `{{ .Token }}`. Browser flows retain the
unmodified `{{ .ConfirmationURL }}`; code-only API emails omit it. See the
#710 operator procedure below for the coordinated URL/template prerequisites.

References: [Supabase template variables and hosted configuration](https://supabase.com/docs/guides/auth/auth-email-templates),
[local template configuration](https://supabase.com/docs/guides/local-development/customizing-email-templates).

## Hosted deployment — operator only

Workers must not access production management credentials, change production or
run `supabase config push` against this sparse repository config. An application
release or database migration does not install hosted email templates.

Use existing authenticated operator access, confirm the project reference below,
and privately retain previous subjects/bodies and URL settings for rollback.
Never export auth configuration, credentials, live messages, OTPs, links or sessions
into GitHub or artifacts. Record only source commit/hash, UTC test times,
template match booleans and sanitized per-flow results.

## #710: code-only API emails (operator action required)

The owner confirmed that typing a fresh code works, but opening its link first
consumes it. Start/verify types, PKCE and code length are not the cause.
Supabase reports wrong, expired and used codes together; clients must not pretend
to know which occurred. See [Supabase's error contract](https://supabase.com/docs/guides/auth/debugging/error-codes).

The API now sends a trusted, server-configured redirect:
`ARMADA_PUBLIC_URL` origin + `/login?flow=code`. It retains the existing
request validation and numeric verification contract, including build-1 iOS
compatibility. The template omits the consuming link when RedirectTo equals
SiteURL + that path. Dashboard and non-API browser/PKCE emails retain their link.
The marker page is not a session callback and never receives a token.

Operator-only hosted changes for project `dhfldqnfyimjjehkngmm`:
1. Authentication → URL Configuration → **Site URL**:
   `https://armada.thevibecompany.co` (no trailing slash).
2. **Redirect URLs**: add exact
   `https://armada.thevibecompany.co/login?flow=code` and
   `https://armada.thevibecompany.co/auth/callback`.
   Preserve existing browser OAuth and CLI loopback allow-list entries; no new
   loopback entry is needed for API email login.
3. Email provider: **Email OTP Length = 6**, **Email OTP Expiration = 3600**
   seconds; no change needed if already set. Existing clients accept 6–10 digits.
4. Install the reviewed canonical subject/body in **Magic Link** AND
   **Confirm signup** (new email users). Keep private backups of both; reload
   and compare both. This supersedes the earlier Magic-Link-only restriction
   for this ticket. Set server `ARMADA_PUBLIC_URL=https://armada.thevibecompany.co`.
   Template, Site URL and allow-list must agree before requesting an email.
   No migration, production config push, SMTP or rate-limit change is needed.

Postflight with separate fresh emails: current TestFlight and CLI emails must
contain the numeric code and **no link**, and typed codes must sign in.
A new-user email must also contain the code without a link. Dashboard emails must
retain a working link and code; opening a link then entering that same code must
show the safe used/expired/incorrect explanation in iOS/CLI. Request another email
to recover. Never record live codes, message bodies, links or sessions.
Rollback restores the two privately saved templates and previous URL settings,
not an entire auth configuration.
