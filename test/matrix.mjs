// Provider-matrix e2e: runs the REAL SyncEngine/DavClient/resolveSlug
// against every active connection on production.
//   CB_KEY=cb_live_… node test/matrix.mjs
import * as fs from "fs/promises";
import * as path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { DavClient } = require("./bundle/dav.js");
const { ApiClient } = require("./bundle/api.js");
const { SyncEngine, resolveSlug } = require("./bundle/sync.js");
const { FakeAdapter } = require("./bundle/stub.js");

const KEY = process.env.CB_KEY;
if (!KEY) { console.error("CB_KEY required"); process.exit(1); }
const SERVER = "https://cloud-bridge.ru";
const FOLDER = "Obsidian-matrix";

const results = { pass: 0, fail: 0 };
const check = (name, ok, extra = "") => {
	results[ok ? "pass" : "fail"]++;
	console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
};

const api = new ApiClient(SERVER, KEY);
const conns = await api.connections();
console.log(`${conns.length} connections\n`);

for (const c of conns) {
	const label = `${c.provider} — ${c.account_email || "#" + c.id}`;
	console.log(`=== ${c.id} ${label} ===`);
	const dav = new DavClient(SERVER, KEY);
	try {
		// 1) slug resolution — both paths
		const s1 = { connectionLabel: label, connectionSlug: c.dav_slug };
		const slugA = await resolveSlug(dav, s1);
		check("slug (authoritative)", slugA === c.dav_slug, slugA);
		const s2 = { connectionLabel: label, connectionSlug: "" };
		const slugB = await resolveSlug(dav, s2).catch((e) => `ERR:${e.message}`);
		check("slug (label fallback)", slugB === c.dav_slug, slugB);

		// 2) dav file ops
		const dir = `${slugA}/${FOLDER}`;
		await dav.ensureDir(dir);
		const payload = new TextEncoder().encode(`cb-test-${c.id}-${Date.now()}`);
		const fpath = `${dir}/тест файл.md`;
		await dav.put(fpath, payload.buffer);
		const st = await dav.stat(fpath);
		check("put+stat", !!st && st.size === payload.length,
			st ? `size=${st.size}` : "no stat");
		const got = new Uint8Array(await dav.get(fpath));
		check("get roundtrip", Buffer.from(got).equals(Buffer.from(payload)),
			`${got.length}B vs ${payload.length}B`);

		// 3) SyncEngine mini-run: one local file → up → no-op
		const tmp = await fs.mkdtemp("/tmp/cb-mx-");
		await fs.writeFile(path.join(tmp, "note.md"), `# ${c.provider}\n`);
		const settings = {
			serverUrl: SERVER, apiKey: KEY,
			connectionId: c.id, connectionLabel: label,
			connectionSlug: c.dav_slug || "",
			remoteFolder: FOLDER, syncIntervalMin: 0,
			syncOnSave: false, twoWay: true, propagateDeletes: true,
			includeHidden: false, lastSync: 0, syncState: {},
		};
		const plugin = {
			app: { vault: { adapter: new FakeAdapter(tmp) } },
			settings, scheduleSync() {},
			setStatus() {}, async saveSettings() {},
		};
		const sync = new SyncEngine(plugin);
		await sync.run("manual");
		const names = (await dav.walk(dir)).map((e) => e.path.split("/").pop());
		check("sync push", names.includes("note.md") && names.includes("тест файл.md"),
			names.join(","));
		await sync.run("manual");
		check("no-op sync", Object.keys(settings.syncState).length >= 1);

		// cleanup
		for (const p of ["тест файл.md", "note.md", "удалённый.md", ""]) {
			try { await dav.delete(`${dir}/${p}`); } catch { /* gone */ }
		}
		try { await dav.delete(dir); } catch { /* not empty / gone */ }
		await fs.rm(tmp, { recursive: true, force: true });
	} catch (e) {
		check("provider flow", false, String(e.message || e).slice(0, 140));
	}
}

console.log(`\nRESULT: ${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail ? 1 : 0);
