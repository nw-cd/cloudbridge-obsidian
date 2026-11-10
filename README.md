# CloudBridge for Obsidian

Sync your Obsidian vault to **any cloud** — Yandex Disk, Google Drive, VK Cloud, Dropbox, Telegram, MEGA and 15+ more — through your [CloudBridge](https://cloud-bridge.ru) account. One vault, your choice of storage.

## Features

- **Two-way vault sync** — edits made in the cloud (another device, another Obsidian) come back down
- **Conflict safety** — when both sides changed, the newer wins and the loser is kept as `name.conflict-<timestamp>.md`
- **Cloud attachments** — one command uploads a note's images/files to your cloud and rewrites embeds to public CloudBridge links
- **Status bar** — sync progress and last-sync time at a glance

## Installation

**From the official directory (recommended):**

Settings → Community plugins → Browse → search «CloudBridge» → Install → Enable. Plugin page: [community.obsidian.md/plugins/cloudbridge](https://community.obsidian.md/plugins/cloudbridge).

**Manual:**

1. Download `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/nw-cd/cloudbridge-obsidian/releases/latest).
2. Create `<vault>/.obsidian/plugins/cloudbridge/` and copy the three files in.
3. Reload Obsidian → Settings → Community plugins → enable **CloudBridge**.

**Via BRAT (for beta builds):**

1. Install the **BRAT** plugin: Settings → Community plugins → Browse → search «Obsidian42 - BRAT» → Install → Enable.
2. Open the command palette → **BRAT: Add a beta plugin for testing**.
3. Paste `nw-cd/cloudbridge-obsidian` → Add Plugin.
4. Enable **CloudBridge** in Settings → Community plugins.

## Setup

1. In CloudBridge → **Dashboard → API** create an API key (`cb_live_…`). Requires the API add-on.
2. Plugin settings → paste the key, hit **Fetch clouds**, pick the target cloud.
3. Run **CloudBridge: Sync vault now** (command palette or the cloud ribbon icon).

The vault mirrors into `<remote folder>/` at the cloud root — `Obsidian/` by default. Open the same folder in a second Obsidian instance and the vault syncs between devices.

## How it works

- File operations go through the CloudBridge **network drive** (`/dav/`) — the same WebDAV endpoint Finder/Explorer users mount
- Connection list and share-links use the **REST API** (`/api/v1/`)
- Sync state (per-file mtime/size) lives in plugin `data.json` — first sync moves everything, later runs are diffs only
- Deletions are **not** propagated by default (a missing file is re-downloaded, not deleted). Turn on «Propagate deletions» for true mirroring

## Settings

| Setting | Default | What it does |
|---|---|---|
| Server | `https://cloud-bridge.ru` | CloudBridge instance |
| Remote folder | `Obsidian` | Cloud folder the vault mirrors into |
| Sync interval | `15` min | `0` = manual only |
| Sync on save | on | Push a file ~8 s after editing stops |
| Two-way sync | on | Pull remote changes too |
| Propagate deletions | off | Deleting locally deletes remotely (and back) |
| Hidden folders | off | Include `.obsidian`, `.trash`, etc. |

## Development

```bash
npm install
npm run dev      # watch-build into main.js
npm run build    # typecheck + production bundle
```

Symlink into a vault for local testing:

```bash
ln -s <repo>/obsidian-plugin "<vault>/.obsidian/plugins/cloudbridge"
# reload Obsidian → Community plugins → enable CloudBridge
```
