# Armada sign-in email

Canonical subject: **Your Armada sign-in code and link**

Canonical body: [supabase/templates/magic-link.html](../supabase/templates/magic-link.html).
The local Supabase template mapping lives in [config.toml](../supabase/config.toml).
The code is Supabase's one-time `{{ .Token }}`; the link remains the unmodified
`{{ .ConfirmationURL }}`. This does not change verification, PKCE, redirect
selection, token expiry, rate limits, or account-creation policy. It fixes the
email content, not the authentication endpoints.

References: [Supabase template variables and hosted configuration](https://supabase.com/docs/guides/auth/auth-email-templates),
[local template configuration](https://supabase.com/docs/guides/local-development/customizing-email-templates).

## Hosted deployment — root/operator only

Workers must not access production management credentials or change production.
Root owns deployment and the real-email/iOS postflight for issue #697.
No application release or database migration applies an email template.

**Do not run `supabase config push` against this repository's sparse config.**
Omitted auth fields may acquire CLI defaults; a template-only TOML fragment is
not proof that a push changes only the template. CLI v2.118 config diff may be
used privately for investigation, but is not the deployment procedure here.
Do not add auth defaults, site URL, SMTP, redirect allowlists, expiry or rate-limit
settings to make that diff clean.

1. Check out the exact reviewed PR head. Record its commit and the SHA-256 of
   `supabase/templates/magic-link.html` and `supabase/config.toml`.
2. Using existing authenticated operator access, open Supabase project
   `dhfldqnfyimjjehkngmm` → Authentication → Email Templates → **Magic Link**.
   Confirm the project reference before saving.
3. Privately retain the existing Magic Link subject/body for rollback. Never
   export the whole auth configuration or put credentials, live messages,
   OTPs, sign-in URLs, sessions, or management responses into GitHub or artifacts.
4. Change **only** the Magic Link subject to the canonical subject above and its
   body to the exact contents of `supabase/templates/magic-link.html`. Save.
   Do not edit Confirm signup, SMTP or any other template or auth setting.
   At the Management API boundary these two owned fields are
   `mailer_subjects_magic_link` and `mailer_templates_magic_link_content`;
   no broad auth-config replacement is authorized.
5. Reload the Magic Link editor and compare both saved fields with the reviewed
   source, including the literal Token and ConfirmationURL placeholders. If the
   editor normalizes line endings, compare with LF normalization only. Record
   only subject/body match booleans and the source commit/hash, not response
   payloads. If either differs, stop and correct it before requesting an email.

## Private postflight (not replaced by fixture verification)

Use the existing public email/start flow from the actual iOS app to request a
**fresh** email after deployment. Inspect it privately: it must include a numeric
code and the sign-in link. Enter the code in that same iOS sign-in flow; confirm
email/verify succeeds and the app reaches authenticated state. Do not click the
same email's link first: code and link consume the same one-time credential.

With separate fresh emails, verify the existing web magic-link/PKCE flow and CLI
magic-link flow still complete, and the CLI code fallback works. Keep existing
redirect configuration and browser/session continuity. Do not alter expiry or
rate limits to speed up testing.

Report only UTC test times, source commit/hash, template/subject readback match,
code-present/link-present booleans, and per-flow success/failure. Never record
screenshots of real messages, OTPs, links, session tokens or message payloads.
A synthetic rendered preview proves layout only, not delivery or authentication.
Issue acceptance remains pending until root confirms real email and iOS success.

## Rollback

If postflight fails, root restores **only** the privately retained previous Magic
Link subject/body in the same editor, saves, reloads and verifies those two fields.
Do not restore an entire auth configuration. Diagnose using sanitized outcomes;
never ask a worker to fetch production messages or credentials.
