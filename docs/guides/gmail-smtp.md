# Sending email through Gmail: Nodemailer, and Fox

This guide sets up a Gmail account as an SMTP relay for a local Node.js app with
[Nodemailer](https://nodemailer.com), then points Fox at the same account so it
can send invites, password-reset codes and its test email.

Every value in angle brackets (`<like-this>`) is a placeholder. No real address,
password or key appears in this guide, and none should appear in anything you
commit.

## 1. Get the credential Gmail wants: an App Password

Gmail does not accept your normal Google password over SMTP. It takes an
**App Password**: a 16-character code that works only for mail sign-in, which
you can revoke on its own without changing your Google password. It is the "API
key" for sending, and it deserves the same care as one.

1. Turn on **2-Step Verification** for the Google account
   (Google Account → Security). App Passwords are not offered without it.
2. Open <https://myaccount.google.com/apppasswords>.
3. Name it after where it will be used, for example `fox-local` or
   `nodemailer-dev`. One App Password per app means you can revoke one without
   breaking the others.
4. Google shows the code once. Put it straight into your `.env` file or Fox's
   Email screen (below). Do not paste it into chat, tickets, screenshots or
   commit messages.

If the App Passwords page says the setting is unavailable, either 2-Step
Verification is off, or the account is a Google Workspace account whose admin
has disabled App Passwords. In that case, ask the admin, or use OAuth2 with
Nodemailer (section 4).

### Gmail's SMTP settings

| Setting  | Value                                                  |
|----------|--------------------------------------------------------|
| Host     | `smtp.gmail.com`                                       |
| Port     | `587` with STARTTLS (recommended), or `465` with implicit TLS |
| Username | the full Gmail address                                 |
| Password | the App Password (spaces optional)                     |
| From     | the same Gmail address, or an alias verified in Gmail settings |

Gmail rewrites the `From` to the signed-in account when you name an address it
has not verified as an alias, so set `From` to the account itself. A personal
Gmail account is meant for low volume (Google caps it at a few hundred messages
a day); for real production mail, use a transactional mail provider instead.

## 2. Keep the secret out of the code

Put the credential in a `.env` file that git ignores. In this repository, `.env`,
`.env.local` and `.env.*.local` are already in `.gitignore`; check yours with:

```bash
git check-ignore -v .env
```

`.env` (never committed):

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USERNAME=<your-account>@gmail.com
SMTP_PASSWORD=<16-character app password>
SMTP_FROM="Fox <<your-account>@gmail.com>"
```

`.env.example` (committed) lists the names with **empty** values, so a newcomer
knows what to fill in without seeing yours:

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_FROM=
```

Rules that keep it from leaking:

- Never hard-code the password in source, tests, fixtures, Dockerfiles or
  `docker-compose*.yml`. Pass it in from the environment.
- Never log the transport options object; it holds the password. Log the host
  and port only.
- Never send the password to the browser. A UI should show "password saved",
  not the value.
- If an App Password lands anywhere public (a commit, a pushed branch, a
  screenshot, a chat), revoke it at once on the App Passwords page and create
  a new one. Deleting the commit is not enough: forks, caches and CI logs keep
  copies.

## 3. Send a message with Nodemailer

```bash
npm install nodemailer dotenv
```

`send-test.mjs`:

```js
import 'dotenv/config';
import nodemailer from 'nodemailer';

const { SMTP_HOST, SMTP_PORT, SMTP_SECURITY, SMTP_USERNAME, SMTP_PASSWORD, SMTP_FROM } = process.env;

if (!SMTP_USERNAME || !SMTP_PASSWORD) {
  throw new Error('Set SMTP_USERNAME and SMTP_PASSWORD in .env');
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST ?? 'smtp.gmail.com',
  port: Number(SMTP_PORT ?? 587),
  secure: SMTP_SECURITY === 'tls', // true for 465 (implicit TLS); false for 587, which upgrades with STARTTLS
  requireTLS: SMTP_SECURITY !== 'none', // refuse to send the password over a connection that never upgraded
  auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
});

// Checks the connection and the sign-in before sending anything.
await transporter.verify();
console.log(`Signed in to ${SMTP_HOST}:${SMTP_PORT}`);

const to = process.argv[2];
if (!to) throw new Error('Usage: node send-test.mjs <recipient>');

const info = await transporter.sendMail({
  from: SMTP_FROM ?? SMTP_USERNAME,
  to,
  subject: 'Nodemailer test',
  text: 'If you can read this, Gmail SMTP works.',
  html: '<p>If you can read this, <b>Gmail SMTP works</b>.</p>',
});

console.log(`Sent: ${info.messageId}`);
```

```bash
node send-test.mjs <recipient@example.com>
```

What the common errors mean:

| Error | Cause |
|-------|-------|
| `535-5.7.8 Username and Password not accepted` | The normal Google password was used, the App Password was mistyped or revoked, or the username is not the full address. |
| `534-5.7.9 Application-specific password required` | 2-Step Verification is on, but the normal password was used. Use an App Password. |
| `ETIMEDOUT` / `ECONNREFUSED` | The network blocks outbound 587/465 (common on some ISPs, cloud hosts and office networks). Try the other port, or another network. |
| `wrong version number` | `secure: true` on port 587, or `secure: false` on port 465. |

### Testing without sending real mail

While building templates you rarely want to hit a real inbox. Run a local
catch-all SMTP server such as [Mailpit](https://mailpit.axllent.org) and point
the app at it: nothing leaves your machine, and no password is needed.

```bash
docker run --rm -p 1025:1025 -p 8025:8025 axllent/mailpit
```

```bash
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURITY=none
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_FROM="Fox <fox@localhost>"
```

Open <http://localhost:8025> to see every message the app sent. With no
username, leave `auth` out of the Nodemailer transport. Switch to Gmail only for
the final end-to-end check.

## 4. Optional: OAuth2 instead of an App Password

Nodemailer can also sign in to Gmail with OAuth2 (`auth: { type: 'OAuth2', … }`),
using a client ID, client secret and refresh token from a Google Cloud project.
Nothing about it is a password, and it is the route when a Workspace admin has
disabled App Passwords. It takes more setup, and those three values are secrets
too: they follow the same `.env` rules as above.

Fox does **not** support OAuth2 for mail: its SMTP client signs in with
`AUTH PLAIN` or `AUTH LOGIN` only, so Fox needs an App Password.

## 5. Point Fox at Gmail

Fox does not use Nodemailer. It has its own small SMTP client
(`packages/db/src/mail/smtp.ts`) that speaks implicit TLS (465), STARTTLS (587)
or plain (a local relay), with `AUTH PLAIN` or `AUTH LOGIN`. The Gmail settings
above work for it unchanged. Set them up one of two ways.

### Option A: on the Email screen (recommended)

1. Sign in as an admin and open **Access control → Sign-in → Email**.
2. Pick the **Gmail / Google Workspace** preset. It fills in
   `smtp.gmail.com`, port `587`, STARTTLS.
3. Enter the Gmail address as the username, the App Password as the password,
   and a sender such as `Fox <<your-account>@gmail.com>`. Save.
4. Type your own address under **Send test email** and send it. The subject is
   *Fox email test*.

Fox encrypts the password before storing it, and the screen only ever reads
back whether a password is saved, never the password itself.

### Option B: environment variables

Put the same six `SMTP_*` lines from section 2 into the server's environment
(`.env` for `npm run dev`, or your Docker / hosting secret store), and set
`APP_PUBLIC_URL` so reset and invite links point at the right place. Restart the
server. The Email screen then shows the settings as **set by environment
variables** and does not let anyone edit them from the UI. The *Send test email*
button still works.

### Testing the send from a script

The test email is an admin-only API call, authorized by the admin's signed-in
session, not by an API key:

```
POST /api/admin/sign-in/mail/test
{"to": "<recipient@example.com>"}
```

It needs the `admin.users` permission, is limited to five calls a minute, and
returns Fox's error text when the relay refuses (for example Gmail's `535`). The
button on the Email screen makes this same call, so use the button unless you
are writing an end-to-end test. If you do script it, sign in through the test
helpers and reuse the session; never put a session cookie or the App Password
in the test file.

### What Fox does without email

Without a relay, invite and reset codes go to the server log (and to the admin
who issued them), and `foxschema reset-password [email]` prints a fresh reset
code on the server. Email-verification codes go through the Fox mail service
instead (`FOX_VERIFY_MAIL_URL`; set it to `off` to send nothing outside the
install). See [DEPLOYMENT.md](DEPLOYMENT.md#email-for-invites-and-resets).

## Checklist before you commit

```bash
git diff --cached | grep -niE '^\+.*(SMTP_PASSWORD=[^<[:space:]]|pass:[[:space:]]*["'\''][^"'\'']+)' || echo "no credentials staged"
```

- [ ] The App Password is only in `.env` or Fox's Email screen.
- [ ] `.env.example` has empty `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`.
- [ ] No screenshot shows the password field filled in or the App Passwords page.
- [ ] Nothing logs the transport options.
- [ ] `npm run verify` passes: its gitleaks step catches most secrets that slip
      into a commit.
