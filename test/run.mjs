// E2E harness: runs the REAL DavClient/ApiClient/SyncEngine code
// (bundled from src/) against production. Usage:
//   CB_KEY=cb_live_… node test/run.mjs
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { DavClient } = require("./bundle/dav.js");
const { ApiClient } = require("./bundle/api.js");
const { SyncEngine } = require("./bundle/sync.js");
const { FakeAdapter } = require("./bundle/stub.js");

const KEY = process.env.CB_KEY;
if (!KEY) { console.error("CB_KEY required"); process.exit(1); }
const SERVER = "https://cloud-bridge.ru";

const settings = {
	serverUrl: SERVER, apiKey: KEY,
	connectionId: 93, connectionLabel: "koofr — nwcd28@gmail.com",
	remoteFolder: "Obsidian-e2e", syncIntervalMin: 0,
	syncOnSave: false, twoWay: true, propagateDeletes: true,
	includeHidden: false, lastSync: 0, syncState: {},
};

const tmp = await fs.mkdtemp("/tmp/cb-vault-");
await fs.writeFile(path.join(tmp, "заметка.md"), "# Тест\nстрока один\n");
await fs.mkdir(path.join(tmp, "подпапка"), { recursive: true });
await fs.writeFile(path.join(tmp, "подпапка/файл.md"), "вложенный файл\n");
await fs.writeFile(path.join(tmp, "картинка.png"), Buffer.alloc(3000, 7));

const plugin = {
	app: { vault: { adapter: new FakeAdapter(tmp) } },
	settings,
	scheduleSync() {},
	setStatus(t) { console.log(`  [status] ${t}`); },
	async saveSettings() {},
};

const sync = new SyncEngine(plugin);
const results = { pass: 0, fail: 0 };
const check = (name, ok) => {
	results[ok ? "pass" : "fail"]++;
	console.log(`  ${ok ? "PASS" : "FAIL"} ${name}`);
};

console.log("=== run 1: initial push ===");
await sync.run("manual");
const dav = new DavClient(SERVER, KEY);
let remote = await dav.walk("Koofr (nwcd28@gmail.com)/Obsidian-e2e");
const rpaths = remote.map((e) => e.path).sort();
check("3 files uploaded", rpaths.length === 3);
check("unicode names land", rpaths.some((p) => p.includes("заметка")));
check("nested file lands", rpaths.some((p) => p.includes("подпапка/файл")));
check("state saved", Object.keys(settings.syncState).length === 3);

console.log("=== run 2: no-op (diff must be empty) ===");
const before = JSON.stringify(settings.syncState);
await sync.run("manual");
check("state stable — no phantom diff",
	JSON.stringify(settings.syncState) === before ||
	Object.keys(settings.syncState).length === 3);

console.log("=== run 3: local change → upload ===");
await fs.writeFile(path.join(tmp, "заметка.md"), "# Тест\nстрока один\nещё строка\n");
await new Promise((r) => setTimeout(r, 1100));
await sync.run("manual");
const st = await dav.stat("Koofr (nwcd28@gmail.com)/Obsidian-e2e/заметка.md");
check("remote file updated", st && st.size > 30);

console.log("=== run 4: remote change → pull ===");
await dav.put("Koofr (nwcd28@gmail.com)/Obsidian-e2e/удалённый.md",
	new TextEncoder().encode("создано в облаке").buffer);
await new Promise((r) => setTimeout(r, 1100));
await sync.run("manual");
const pulled = await fs.readFile(path.join(tmp, "удалённый.md"), "utf8").catch(() => null);
check("remote file pulled", pulled === "создано в облаке");

console.log("=== run 5: api — connections + share link ===");
const api = new ApiClient(SERVER, KEY);
const conns = await api.connections();
check("connections listed", conns.length > 0 && !!conns.find(c => c.id === 93));
const files = await api.files(93, "Obsidian-e2e");
check("files listed via REST", files.length >= 4);
const link = await api.shareLink(93, files.find(f => f.name === "картинка.png"));
check("share link created", !!link.download && link.download.includes("/api/share/s/"));

console.log("=== cleanup ===");
for (const p of ["заметка.md", "удалённый.md", "картинка.png",
	"подпапка/файл.md", "подпапка", ""])
	try { await dav.delete(`Koofr (nwcd28@gmail.com)/Obsidian-e2e/${p}`); }
	catch { /* gone */ }
await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nRESULT: ${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail ? 1 : 0);
