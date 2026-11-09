import { Notice, normalizePath } from "obsidian";
import type CloudBridgePlugin from "./main";
import { DavClient, DavEntry } from "./dav";
import { FileState } from "./settings";

interface LocalFile { mtime: number; size: number }

const CONCURRENCY = 4;
const MAX_FILE = 512 * 1024 * 1024;   // sanity cap; dav limit is 40 GB

// provider keys from the API vs /dav/ display labels — the fallback
// label match fails without this ("yandex_disk" vs "Яндекс Диск")
const PROVIDER_LABEL: Record<string, string> = {
	yandex_disk: "Яндекс Диск", google_drive: "Google Drive",
	vk_cloud: "VK Облако", mega: "MEGA", telegram: "Telegram",
	onedrive: "OneDrive", dropbox: "Dropbox", koofr: "Koofr",
	pcloud: "pCloud", box: "Box", google_photos: "Google Photos",
	webdav: "WebDAV", nextcloud: "Nextcloud", owncloud: "ownCloud",
};

/** Resolve the /dav/ folder name of the chosen connection.
 *  Prefers the authoritative slug saved at cloud-pick time;
 *  falls back to provider+email matching for older settings. */
export async function resolveSlug(
	dav: DavClient,
	s: { connectionLabel: string; connectionSlug?: string },
): Promise<string> {
	if (s.connectionSlug) return s.connectionSlug;
	const conns = await dav.connections();
	// "<provider> — <email>" — the email alone is ambiguous when
	// one account backs several clouds (e.g. gmail → Dropbox + Koofr)
	const [prov, email] = s.connectionLabel.split("—").map((x) => x.trim());
	const provLabel = (PROVIDER_LABEL[prov] || prov).toLowerCase();
	const hit = conns.find((c) =>
		!!email && c.slug.includes(email) &&
		c.slug.toLowerCase().startsWith(provLabel))
		|| conns.find((c) => !!email && c.slug.includes(email))
		|| conns.find((c) => c.slug === s.connectionLabel);
	if (!hit)
		throw new Error(
			`Облако "${s.connectionLabel}" не найдено на диске — перепроверь ключ`);
	return hit.slug;
}

/**
 * Mirror-sync between the vault and <dav>/<cloud slug>/<remoteFolder>.
 * State (per-path last-synced mtime/size) lives in plugin data — first
 * sync uploads everything; later runs move only diffs. Conflicts are
 * resolved last-write-wins; the losing side is kept as
 * "<name>.conflict-<ts>.<ext>".
 */
export class SyncEngine {
	running = false;
	private slug: string | null = null;
	private slugConn = 0;
	private pending = new Set<string>();

	constructor(private plugin: CloudBridgePlugin) {}

	private get settings() { return this.plugin.settings; }

	private dav(): DavClient {
		return new DavClient(this.settings.serverUrl, this.settings.apiKey);
	}

	/** Resolve the /dav/ folder name of the chosen connection once —
	 *  list the drive root and match by the account email we got
	 *  from /api/v1/connections. */
	private async remoteRoot(dav: DavClient): Promise<string> {
		// slug is cached per connection — switching clouds in settings
		// must re-resolve, otherwise sync keeps writing to the old cloud
		if (!this.slug || this.slugConn !== this.settings.connectionId) {
			this.slug = await resolveSlug(dav, this.settings);
			this.slugConn = this.settings.connectionId;
		}
		return `${this.slug}/${this.settings.remoteFolder}`;
	}

	/** Called on vault modify — debounce into a run. */
	onLocalChange(path: string): void {
		this.pending.add(path);
		this.plugin.scheduleSync();
	}

	async run(trigger = "manual"): Promise<void> {
		if (this.running) return;
		const s = this.settings;
		if (!s.apiKey || !s.connectionId) {
			if (trigger === "manual")
				new Notice("CloudBridge: set API key and cloud in settings");
			return;
		}
		this.running = true;
		this.plugin.setStatus("⟳");
		const dav = this.dav();
		try {
			const root = await this.remoteRoot(dav);
			await dav.ensureDir(root);

			const local = await this.scanVault();
			// keys vault-relative — walk() returns full dav paths
			// (<slug>/<remoteFolder>/…) so the root prefix goes away
			const remote = new Map<string, DavEntry>();
			for (const e of await dav.walk(root))
				remote.set(e.path.slice(root.length + 1), e);

			const actions = this.plan(local, remote, s.syncState);
			let done = 0, errors = 0;
			const total = actions.length;
			const queue = [...actions];

			await Promise.all(Array(CONCURRENCY).fill(0).map(async () => {
				while (queue.length) {
					const a = queue.shift()!;
					try {
						await this.exec(dav, root, a);
						done++;
					} catch (e) {
						errors++;
						console.error(`[cloudbridge] ${a.kind} ${a.path}:`, e);
					}
					this.plugin.setStatus(`⟳ ${done + errors}/${total}`);
				}
			}));

			s.lastSync = Date.now();
			await this.plugin.saveSettings();
			this.plugin.setStatus(
				errors ? `⚠ ${errors} err` : `✓ ${new Date().toLocaleTimeString().slice(0, 5)}`);
			if (trigger === "manual" || errors)
				new Notice(
					`CloudBridge: ${done} файлов синхронизировано` +
					(errors ? `, ${errors} ошибок` : ""));
		} catch (e) {
			console.error("[cloudbridge] sync failed:", e);
			this.plugin.setStatus("⚠");
			new Notice(`CloudBridge sync: ${(e as Error).message}`);
		} finally {
			this.running = false;
		}
	}

	private async scanVault(): Promise<Map<string, LocalFile>> {
		const out = new Map<string, LocalFile>();
		const adapter = this.plugin.app.vault.adapter;
		const walk = async (dir: string) => {
			const { files, folders } = await adapter.list(dir);
			for (const f of files) {
				if (this.skip(f)) continue;
				const st = await adapter.stat(normalizePath(f));
				if (st && st.size <= MAX_FILE)
					out.set(f, { mtime: st.mtime, size: st.size });
			}
			for (const d of folders)
				if (!this.skipDir(d)) await walk(d);
		};
		await walk("");
		return out;
	}

	private skip(path: string): boolean {
		const base = path.split("/").pop() || "";
		if (base.startsWith(".trash") || base === ".DS_Store" ||
			base.startsWith("._") || base.endsWith(".tmp") ||
			base.includes(".conflict-")) return true;
		if (!this.settings.includeHidden &&
			path.split("/").some((p) => p.startsWith("."))) return true;
		return false;
	}

	private skipDir(dir: string): boolean {
		if (!this.settings.includeHidden &&
			dir.split("/").some((p) => p.startsWith("."))) return true;
		return false;
	}

	/** Diff local × remote × stored state → action list. */
	private plan(local: Map<string, LocalFile>,
	             remote: Map<string, DavEntry>,
	             state: Record<string, FileState>) {
		type Act = {
			kind: "up" | "down" | "delRemote" | "delLocal" |
				"conflict-up" | "conflict-down";
			path: string;
		};
		const acts: Act[] = [];
		const paths = new Set([...local.keys(), ...remote.keys(), ...Object.keys(state)]);

		for (const p of paths) {
			if (this.skip(p)) continue;
			const l = local.get(p), r = remote.get(p), s = state[p];
			const lChanged = !!l && (!s || l.mtime !== s.mtime || l.size !== s.size);
			// getlastmodified is second-granular — 2 s tolerance on top of
			// exact size match, else every remote file looks "changed"
			const rChanged = !!r && (!s || r.size !== s.size ||
				Math.abs(r.mtime - (s.remote_mtime || 0)) > 2000);

			if (l && !r) {
				if (!s || !this.settings.propagateDeletes) acts.push({ kind: "up", path: p });
				// s && propagateDeletes: remote deleted it → honour remote, delete local
				else acts.push({ kind: "delLocal", path: p });
			} else if (r && !l) {
				if (!s || !this.settings.propagateDeletes) {
					if (this.settings.twoWay) acts.push({ kind: "down", path: p });
				} else acts.push({ kind: "delRemote", path: p });
			} else if (l && r) {
				if (!s) {
					// both exist, never synced — same size ⇒ assume identical
					if (l.size !== r.size) acts.push({ kind: "up", path: p });
				} else if (lChanged && !rChanged) acts.push({ kind: "up", path: p });
				else if (rChanged && !lChanged && this.settings.twoWay)
					acts.push({ kind: "down", path: p });
				else if (lChanged && rChanged)
					acts.push({
						kind: l.mtime >= r.mtime ? "conflict-up" : "conflict-down",
						path: p,
					});
			}
		}
		return acts;
	}

	private async exec(dav: DavClient, root: string,
	                   a: { kind: string; path: string }) {
		const s = this.settings;
		const remotePath = `${root}/${a.path}`;
		const localPath = normalizePath(a.path);
		const adapter = this.plugin.app.vault.adapter;

		const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
		const conflictCopy = (p: string) =>
			p.replace(/(\.[^.]+)?$/, `.conflict-${stamp}$1`);

		switch (a.kind) {
		case "conflict-up":
			// local wins — keep remote copy locally under .conflict-* first
			await this.downloadAs(dav, remotePath, conflictCopy(localPath));
		// falls through
		case "up": {
			const data = await adapter.readBinary(localPath);
			const dir = remotePath.split("/").slice(0, -1).join("/");
			if (dir !== root) await dav.ensureDir(dir);
			await dav.put(remotePath, data);
			const st = await adapter.stat(localPath);
			// real remote mtime (second-granular) — keeps rChanged exact
			const re = await dav.stat(remotePath).catch(() => null);
			if (st) {
				s.syncState[a.path] = {
					mtime: st.mtime, size: st.size,
					remote_mtime: re?.mtime || Date.now(),
				};
			}
			break;
		}
		case "conflict-down": {
			// remote wins — stash the local copy before overwriting
			const data = await adapter.readBinary(localPath);
			await adapter.writeBinary(conflictCopy(localPath), data);
		}
		// falls through
		case "down":
			await this.downloadAs(dav, remotePath, localPath);
			s.syncState[a.path] = {
				mtime: (await adapter.stat(localPath))?.mtime || Date.now(),
				size: (await adapter.stat(localPath))?.size || 0,
				remote_mtime: (await dav.stat(remotePath))?.mtime || Date.now(),
			};
			break;
		case "delRemote":
			await dav.delete(remotePath);
			delete s.syncState[a.path];
			break;
		case "delLocal":
			await adapter.remove(localPath);
			delete s.syncState[a.path];
			break;
		}
	}

	private async downloadAs(dav: DavClient, remotePath: string,
	                         localPath: string): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		const data = await dav.get(remotePath);
		const dir = localPath.split("/").slice(0, -1).join("/");
		if (dir) await adapter.mkdir(dir);
		await adapter.writeBinary(localPath, data);
	}
}
