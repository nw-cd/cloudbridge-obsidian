// Stub for the "obsidian" module — just enough surface for
// dav.ts / api.ts / sync.ts to run under Node for e2e tests.
import * as fs from "fs/promises";
import * as path from "path";
import { DOMParser } from "linkedom";

(globalThis as any).DOMParser = DOMParser;
(globalThis as any).window = globalThis;

export class Notice {
	constructor(msg: string) { console.log(`[notice] ${msg}`); }
}

export function normalizePath(p: string): string {
	return path.posix.normalize(p).replace(/^\/+/, "");
}

interface ReqOpts {
	url: string; method: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	throw?: boolean;
}

export async function requestUrl(opts: ReqOpts) {
	const res = await fetch(opts.url, {
		method: opts.method,
		headers: opts.headers,
		body: opts.body as BodyInit,
		redirect: "follow",
	});
	const buf = await res.arrayBuffer();
	const out = {
		status: res.status,
		headers: Object.fromEntries(res.headers.entries()),
		text: new TextDecoder().decode(buf),
		arrayBuffer: buf,
		json: undefined as any,
	};
	try { out.json = JSON.parse(out.text); } catch { /* not json */ }
	if (opts.throw !== false && res.status >= 400)
		throw new Error(`${opts.method} ${opts.url} → ${res.status}`);
	return out;
}

// ---- vault adapter over a temp dir ----

export class FakeAdapter {
	constructor(public root: string) {}
	private p(rel: string) { return path.join(this.root, rel); }

	async list(dir: string) {
		const full = this.p(dir);
		const files: string[] = [], folders: string[] = [];
		let ents;
		try { ents = await fs.readdir(full, { withFileTypes: true }); }
		catch { return { files, folders }; }
		for (const e of ents) {
			const rel = dir ? `${dir}/${e.name}` : e.name;
			if (e.isDirectory()) folders.push(rel);
			else files.push(rel);
		}
		return { files, folders };
	}
	async stat(rel: string) {
		try {
			const st = await fs.stat(this.p(rel));
			return { mtime: Math.floor(st.mtimeMs), size: st.size,
				type: st.isDirectory() ? "folder" : "file" };
		} catch { return null; }
	}
	async readBinary(rel: string) {
		const b = await fs.readFile(this.p(rel));
		return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
	}
	async writeBinary(rel: string, data: ArrayBuffer) {
		await fs.mkdir(path.dirname(this.p(rel)), { recursive: true });
		await fs.writeFile(this.p(rel), Buffer.from(data));
	}
	async mkdir(rel: string) {
		await fs.mkdir(this.p(rel), { recursive: true });
	}
	async remove(rel: string) {
		await fs.rm(this.p(rel), { recursive: true, force: true });
	}
}
