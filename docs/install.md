# Install Fox Schema

Fox Schema is a **local web app** launched from the CLI. After install you run
`foxschema` (or double-click the **Fox Schema** desktop shortcut) to open
**http://localhost:3210** in your browser.

Requires **Node.js ≥ 22.5** for npm / Homebrew paths. Docker needs no Node.

---

## Choose a channel

| Platform | Command |
|----------|---------|
| **npm** (macOS / Windows / Linux) | `npm install -g foxschema` |
| **Homebrew** (macOS Arm + Intel) | `brew tap … && brew trust tedious-code/foxschema && brew install foxschema` |
| **Windows** | Install Node (`winget install OpenJS.NodeJS.LTS`), then `npm i -g foxschema` |
| **Docker** (servers, linux/amd64) | `docker pull 5nickels/foxschema:latest` |
| **curl / wget** (scripted npm) | see [curl / wget](#curl--wget) below |

There is **one product** (no separate “Db2 edition”). Db2 works where `ibm_db`
supports your OS/arch; the Docker image includes Db2 on **linux/amd64**.

---

## npm (recommended)

```bash
npm install -g foxschema
foxschema                 # start UI + open browser
foxschema shortcut        # optional: Fox icon on your Desktop
foxschema stop            # shut down the background server
foxschema doctor
```

Works on **arm64 and x64**. Use a native Node build for your CPU
(`node -p process.arch` should match the machine).

---

## Homebrew (macOS)

Formula is in this same repo (`Formula/foxschema.rb`). Homebrew 6+ requires a
one-time `brew trust` for third-party taps:

```bash
brew tap tedious-code/foxschema https://github.com/tedious-code/foxschema
brew trust tedious-code/foxschema
brew install foxschema
foxschema
foxschema shortcut        # Desktop app with fox icon
```

`brew search foxschema` works only after the tap and the one-time trust. There is one formula and one npm package. Db2 is optional on npm and included in the Docker image. After an npm release, maintainers refresh the formula with [packaging/homebrew/update-formula.sh](../packaging/homebrew/update-formula.sh).

---

## Windows

Install Node, then the CLI from npm:

```powershell
winget install OpenJS.NodeJS.LTS
npm install -g foxschema
foxschema
foxschema shortcut
```

---

## Docker

Single image (UI + API, **includes Db2**, **linux/amd64**):

```bash
docker pull 5nickels/foxschema:latest
docker run -d --name foxschema \
  -p 3210:3210 \
  -v foxschema_data:/data \
  5nickels/foxschema:latest
```

Open **http://localhost:3210**. Full deploy guide: [DEPLOYMENT.md](DEPLOYMENT.md).

Also: `ghcr.io/tedious-code/foxschema:latest`.

---

## curl / wget

Install Node first, then:

```bash
# curl
curl -fsSL https://www.npmjs.com/install.sh | sh   # only if you need npm itself
npm install -g foxschema

# or with wget
wget -qO- https://www.npmjs.com/install.sh | sh
npm install -g foxschema
```

Pull the container without Docker Hub login:

```bash
wget -O foxschema.tar https://…   # prefer docker pull instead
docker pull 5nickels/foxschema:latest
```

For CI, prefer:

```bash
npm install -g foxschema@latest
# or
docker pull 5nickels/foxschema:latest
```

---

## Desktop shortcut (Fox icon)

After any CLI install:

```bash
foxschema shortcut
```

Creates **Fox Schema** on your Desktop (macOS `.app` / Windows `.lnk` / Linux `.desktop`).

- Double-click → starts the local UI or **reopens the browser** if the server is
  still running (e.g. you closed the browser without `foxschema stop`).
- The background server keeps running until `foxschema stop`.
- In **Activity Monitor** (macOS) or **Task Manager** (Windows), the backend is a
  Node process titled **`foxschema`** (Windows Image Name is still `node.exe` —
  enable the **Command line** column or run `foxschema doctor` for the PID).
  Prefer `foxschema stop` over killing it by hand.

---

## Everyday commands

```bash
foxschema              # open UI (http://localhost:3210)
foxschema stop         # stop background server
foxschema doctor       # Node, drivers, server status
foxschema compare …    # headless diff
foxschema migrate …    # dry-run / apply migration
foxschema tui          # terminal UI
```

In the UI: **Schema Sync** (compare / migrate) or **SQL Editor** (ad-hoc SQL against
saved connections). Editor walkthrough: [user guide — SQL Editor](user-guide.md#sql-editor).

---

## Publishing (maintainers)

See [publish.md](publish.md) for npm, Homebrew, Docker Hub/GHCR, and release tags.
