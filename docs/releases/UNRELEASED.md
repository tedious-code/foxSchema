# Unreleased

Notes for the next release. At ship time, rename this file to that version's
`RELEASE_<version>.md` and use it as the GitHub Release body.

## Interpolate Variables and Secrets into SQL

**Insert** on a Variables or Secrets row puts `${{name}}` at the editor cursor.
Run still substitutes the real value into the SQL sent to the engine. Secret
payloads stay out of **Out [n]** labels, copy-with-values, and **Recent**
(those keep `${{name}}` or `(secret)`). Public variables still fill in Recent
and labels as before.

## Google Cloud secrets: Connect Google Cloud (OAuth)

**Connect Google Cloud** on Credentials → Cloud providers (or SQL Editor →
Secrets) opens this install’s own Google OAuth client — PKCE, offline access,
`cloud-platform.read-only`. Only the **refresh token** is stored, encrypted, on
the named credential. Fetch lists projects / secrets / versions so you pick
instead of typing a resource name; the value is injected into session Variables
and is never written to `app_secrets.encrypted_value`. Disconnect revokes at
Google, then deletes the credential.

Register the callback
`{public URL}/api/app-secrets/providers/gcp/oauth/callback` on the same Google
OAuth app as Access control → Sign-in → Google. The Fox sign-in service
(foxschema.com) cannot access Secret Manager.

Google Cloud warns that downloaded service-account keys pose a risk if
compromised. New named GCP credentials **refuse** a `private_key` JSON.
Interactive use is **Connect Google Cloud**. Machines paste a Workload
Identity Federation `external_account` client config (no private key), or
use the host identity (ADC / GCE metadata, including WIF via
`GOOGLE_APPLICATION_CREDENTIALS`). Existing stored keys still resolve until
you replace them. AWS and Azure fetch are unchanged.

A pasted Workload Identity Federation config is checked before it is saved and
before each use: its endpoints must be Google’s, and its token may come only
from a file or URL listed in `FOX_GCP_WIF_TOKEN_FILES` / `FOX_GCP_WIF_TOKEN_URLS`
on the server. Nothing is listed by default. Connecting under a name already in
use reconnects that Google Cloud connection and needs **Edit secrets**; it never
replaces another kind of credential.
