// Edge-case e2e: conflicts, deletes, deep nesting, special chars,
// MOVE/COPY, empty + binary files — real plugin code vs production.
//   CB_KEY=cb_live_… CB_CONN=62 node test/edge.mjs
import * as fs from "fs/promises";
import * as path from "path";
import { createRequire } from "module";
import * as crypto from "crypto";

const require = createRequire(import.meta.url);
const { DavClient } = require("./bundle/dav.js");
const { ApiClient } = require("./bundle/api.js");
const { SyncEngine } = require("./bundle/sync.js");
const { FakeAdapter } = require("./bundle/stub.js");

const KEY = process.env.CB_KEY;
const CONN = parseInt(process.env.CB_CONN || "93", 10);
if (!KEY) { console.error("CB_KEY required"); process.exit(1); }
const SERVER = "https://cloud-bridge.ru";
const FOLDER = `Obsidian-edge-${CONN}`;

const results = { pass: 0, fail: 0 };
const check = (name, ok, extra = "") => {
	results[ok ? "pass" : "fail"]++;
	console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
};

const api = new ApiClient(SERVER, KEY);
const conn = (await api.connections()).find((c) => c.id === CONN);
if (!conn) { console.error(`conn ${CONN} not found`); process.exit(1); }
const slug = conn.dav_slug;
console.log(`=== conn ${CONN} ${slug} ===\n`);

const dav = new DavClient(SERVER, KEY);
const tmp = await fs.mkdtemp("/tmp/cb-edge-");

const mkSettings = (over = {}) => ({
	serverUrl: SERVER, apiKey: KEY,
	connectionId: CONN, connectionLabel: `${conn.provider} — x`,
	connectionSlug: slug,
	remoteFolder: FOLDER, syncIntervalMin: 0,
	syncOnSave: false, twoWay: true, propagateDeletes: false,
	includeHidden: false, lastSync: 0, syncState: {},
	...over,
});
const mkPlugin = (settings) => ({
	app: { vault: { adapter: new FakeAdapter(tmp) } },
	settings, scheduleSync() {}, setStatus() {},
	async saveSettings() {},
});

// ---------- deep nesting (3+ levels — key threading path) ----------
console.log("--- deep nesting ---");
await dav.ensureDir(`${slug}/${FOLDER}/a/b/c`);
const deep = "a/b/c/глубоко.md";
await dav.put(`${slug}/${FOLDER}/${deep}`,
	new TextEncoder().encode("deep content").buffer);
const dst = await dav.stat(`${slug}/${FOLDER}/${deep}`);
check("depth-3 put+stat", !!dst && dst.size === 12,
	dst ? `size=${dst.size}` : "null");
const dg = new TextDecoder().decode(
	await dav.get(`${slug}/${FOLDER}/${deep}`));
check("depth-3 get", dg === "deep content");
const walkPaths = (await dav.walk(`${slug}/${FOLDER}`))
	.map((e) => e.path);
check("walk finds depth-3", walkPaths.some((p) => p.endsWith(deep)),
	`${walkPaths.length} entries`);

// ---------- special characters ----------
console.log("--- special names ---");
for (const name of [
	"пробел ы и двойной  пробел.md",
	"апостроф'ы.md",
	"эmoji 🚀 файл.md",
]) {
	const p = `${slug}/${FOLDER}/${name}`;
	try {
		await dav.put(p, new TextEncoder().encode("x").buffer);
		const st2 = await dav.stat(p);
		check(`name ${name.slice(0, 20)}`, !!st2);
	} catch (e) {
		check(`name ${name.slice(0, 20)}`, false, String(e).slice(0, 80));
	}
}

// ---------- empty + binary ----------
console.log("--- empty & binary ---");
await dav.put(`${slug}/${FOLDER}/empty.md`, new ArrayBuffer(0));
const est = await dav.stat(`${slug}/${FOLDER}/empty.md`);
check("empty file stat", !!est && est.size === 0,
	est ? `size=${est.size}` : "null");
const bin = crypto.randomBytes(150_000);
await dav.put(`${slug}/${FOLDER}/bin.dat`, bin.buffer);
const binBack = new Uint8Array(await dav.get(`${slug}/${FOLDER}/bin.dat`));
check("binary roundtrip 150KB",
	crypto.createHash("md5").update(binBack).digest("hex") ===
	crypto.createHash("md5").update(bin).digest("hex"));

// ---------- MOVE & COPY ----------
console.log("--- move/copy ---");
await dav.put(`${slug}/${FOLDER}/src.md`,
	new TextEncoder().encode("mv").buffer);
await dav.move(`${slug}/${FOLDER}/src.md`,
	`${slug}/${FOLDER}/moved.md`);
check("move", !(await dav.stat(`${slug}/${FOLDER}/src.md`)) &&
	!!(await dav.stat(`${slug}/${FOLDER}/moved.md`)));
await dav.copy(`${slug}/${FOLDER}/moved.md`,
	`${slug}/${FOLDER}/copied.md`);
check("copy", !!(await dav.stat(`${slug}/${FOLDER}/copied.md`)) &&
	!!(await dav.stat(`${slug}/${FOLDER}/moved.md`)));

// ---------- sync: conflict handling ----------
console.log("--- conflict ---");
const s1 = mkSettings();
const p1 = mkPlugin(s1);
await fs.writeFile(path.join(tmp, "conf.md"), "v1\n");
const sync1 = new SyncEngine(p1);
await sync1.run("manual");
check("conf: initial up", !!s1.syncState["conf.md"]);

// change BOTH sides → local is newer → conflict-up keeps remote copy
await fs.writeFile(path.join(tmp, "conf.md"), "v1\nlocal edit\n");
await dav.put(`${slug}/${FOLDER}/conf.md`,
	new TextEncoder().encode("v1\nremote edit\n").buffer);
await new Promise((r) => setTimeout(r, 1200));
// remote now has newer mtime → remote should win → conflict-down
await sync1.run("manual");
const locals = await fs.readdir(tmp);
const confCopies = locals.filter((f) => f.includes("conflict"));
check("conflict copy created", confCopies.length >= 1,
	confCopies.join(","));
const confBody = await fs.readFile(path.join(tmp, "conf.md"), "utf8");
check("winner content applied",
	confBody.includes("remote edit") || confBody.includes("local edit"),
	confBody.trim().replace(/\n/g, "|"));

// ---------- sync: deletes ----------
console.log("--- deletes ---");
const s2 = mkSettings({ propagateDeletes: false });
const p2 = mkPlugin(s2);
await fs.writeFile(path.join(tmp, "del.md"), "to delete\n");
const sync2 = new SyncEngine(p2);
await sync2.run("manual");
await fs.rm(path.join(tmp, "del.md"));
await sync2.run("manual");
const afterOff = await fs.readFile(path.join(tmp, "del.md"), "utf8")
	.catch(() => null);
const remoteAfterOff = await dav.stat(`${slug}/${FOLDER}/del.md`);
check("delete OFF: remote kept + re-pulled",
	!!remoteAfterOff && afterOff === "to delete\n",
	`local=${JSON.stringify(afterOff)}`);

const s3 = mkSettings({ propagateDeletes: true });
const p3 = mkPlugin(s3);
await fs.writeFile(path.join(tmp, "del2.md"), "gone\n");
const sync3 = new SyncEngine(p3);
await sync3.run("manual");
await fs.rm(path.join(tmp, "del2.md"));
await sync3.run("manual");
const remoteDel2 = await dav.stat(`${slug}/${FOLDER}/del2.md`);
check("delete ON: remote deleted", !remoteDel2);

// ---------- overwrite existing ----------
console.log("--- overwrite ---");
await dav.put(`${slug}/${FOLDER}/ow.md`,
	new TextEncoder().encode("first").buffer);
await new Promise((r) => setTimeout(r, 800));
await dav.put(`${slug}/${FOLDER}/ow.md`,
	new TextEncoder().encode("second-longer").buffer);
const ow = new TextDecoder().decode(
	await dav.get(`${slug}/${FOLDER}/ow.md`));
check("overwrite (stage-rename)", ow === "second-longer", ow);
const owList = (await dav.walk(`${slug}/${FOLDER}`))
	.filter((e) => e.path.endsWith("/ow.md"));
check("no duplicates after overwrite", owList.length === 1);

// ---------- cleanup ----------
console.log("--- cleanup ---");
const entries = await dav.walk(`${slug}/${FOLDER}`).catch(() => []);
for (const e of [...entries].sort(
	(a, b) => b.path.length - a.path.length)) {
	try { await dav.delete(e.path); } catch { /* gone */ }
}
try { await dav.delete(`${slug}/${FOLDER}`); } catch { /* gone */ }
await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nRESULT: ${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail ? 1 : 0);
