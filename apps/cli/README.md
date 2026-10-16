# foxschema

**Fox Schema** — compare database schemas, generate migrations, and run a rich
**SQL Editor** in your browser. One global CLI: `foxschema`.

[![npm](https://img.shields.io/npm/v/foxschema.svg?logo=npm)](https://www.npmjs.com/package/foxschema)
[![Docker](https://img.shields.io/docker/v/5nickels/foxschema?label=docker&logo=docker)](https://hub.docker.com/r/5nickels/foxschema)
[![TypeScript](https://img.shields.io/badge/TypeScript-5+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node ESM](https://img.shields.io/badge/Node-ESM%20%2B%20CJS%20deps-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://github.com/tedious-code/foxschema/blob/main/LICENSE)

```bash
npm install -g foxschema
foxschema                 # UI → http://localhost:3210
```

## SQL Editor (0.2)

Multi-destination queries, notebook-style cells, Data Peek, FoxScript, variables,
and Safe mode — next to Schema Sync in the same UI.

![SQL Editor](https://raw.githubusercontent.com/tedious-code/foxschema/main/docs/demo/sql-editor.gif)

| | |
|--|--|
| Multi-destination Run | By-cred / Side-by-side result grids |
| Notebook cells | SQL + `@js` / `@ts` / `@node` with `Out [n]` |
| Data Peek | Cmd/Ctrl-click Schema tables · click rust FK cells in results |
| Peek tools | WHERE / ORDER BY / LIMIT · Prev/Next · arrange · resize |
| Variables | `${{name}}`, `@set`, session secrets |

## Schema Sync

![Schema Sync](https://raw.githubusercontent.com/tedious-code/foxschema/main/docs/demo/foxschema-demo.gif)

Diff source vs target, generate migration DDL, dry-run by default.

## Install channels

```bash
# npm
npm install -g foxschema

# Homebrew (macOS)
brew tap tedious-code/foxschema https://github.com/tedious-code/foxschema
brew trust tedious-code/foxschema
brew install foxschema

# Docker (linux/amd64, includes Db2)
docker pull 5nickels/foxschema:latest
docker run -d -p 3210:3210 -v foxschema_data:/data 5nickels/foxschema:latest
```

## CLI

```bash
foxschema                 # start local UI and open the browser
foxschema stop
foxschema shortcut        # Desktop icon
foxschema doctor
foxschema compare --source a --target b
foxschema tui
```

## Package format

- Written in **TypeScript**
- Published CLI entry is **ESM** (`"type": "module"`) with a **`types`** field for editors
- Native DB drivers may resolve as CommonJS at runtime
- **Node.js ≥ 22.5**

## Docs

- [User guide](https://github.com/tedious-code/foxschema/blob/main/docs/user-guide.md)
- [Install](https://github.com/tedious-code/foxschema/blob/main/docs/install.md)
- [Site](https://foxschema.com)

## License

Copyright 2024–2026 Huy Phan · Apache-2.0 · see [NOTICE](https://github.com/tedious-code/foxschema/blob/main/NOTICE)
