# Unreleased

Notes for the next release. At ship time, rename this file to that version's
`RELEASE_<version>.md` and use it as the GitHub Release body.

## Removed: Secrets in the SQL editor

The SQL editor's **Secrets** section is gone, and **Run** no longer merges saved
App Secrets into a run: it substitutes this session's **Variables** only (mark
one **Secret** to mask it). Saved secrets stay in the database, and cloud
credentials stay under Credentials → Cloud providers. The
`editor.sidebar.secrets` permission went with the section.

## Google sign-in can connect Google Cloud

An admin can turn on **Also connect Google Cloud for secrets** on the Google
card under Access control → Sign-in (or `SSO_GOOGLE_CONNECT_GCP=on`). Signing
in with Google then also asks for read-only Google Cloud access, and the first
grant saves a **Google Cloud** connection in the person's personal workspace,
ready for use. Off by default. A connection already there is
never replaced, turning the access down still signs you in, and it needs the
install's own Google app (the Fox sign-in service cannot grant it). With a
dedicated Google Cloud client (`GCP_OAUTH_CLIENT_ID`) it stays off, because the
token would not refresh with that client.

## Interpolate Variables and Secrets into SQL

**Insert** on a Variables row puts `${{name}}` at the editor cursor.
Run still substitutes the real value into the SQL sent to the engine. Secret
payloads stay out of **Out [n]** labels, copy-with-values, and **Recent**
(those keep `${{name}}` or `(secret)`). Public variables still fill in Recent
and labels as before.

## Google Cloud secrets: Connect Google Cloud (OAuth)

**Connect Google Cloud** on Credentials → Cloud providers opens this install’s own Google OAuth client — PKCE, offline access,
`cloud-platform.read-only`. Only the **refresh token** is stored, encrypted, on
the named credential. Disconnect revokes at
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
