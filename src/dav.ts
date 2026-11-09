import { requestUrl } from "obsidian";

export interface DavEntry {
	path: string;      // path relative to the vault remote root ("" = root)
	name: string;
	isDir: boolean;
	size: number;
	mtime: number;     // ms epoch
	etag?: string;
}

export interface DavConnection {
	slug: string;      // folder name under /dav/
	display: string;
}

/**
 * Minimal WebDAV client for the CloudBridge drive endpoint.
 * Server: /dav/<connection slug>/<path> — one folder per connected cloud.
 * Auth: HTTP Basic, API key in the password slot.
 */
export class DavClient {
	constructor(private base: string, private apiKey: string) {
		this.base = base.replace(/\/+$/, "");
	}

	private get auth(): string {
		return `Basic ${window.btoa(`cb:${this.apiKey}`)}`;
	}

	private url(path: string): string {
		const segs = path.split("/").filter(Boolean)
			.map((s) => encodeURIComponent(s));
		return `${this.base}/dav/${segs.join("/")}`;
	}

	private async req(method: string, path: string,
	                  opts: { body?: string | ArrayBuffer; headers?: Record<string, string> } = {}) {
		const res = await requestUrl({
			url: this.url(path),
			method,
			headers: { Authorization: this.auth, ...(opts.headers || {}) },
			body: opts.body,
			throw: false,
		});
		return res;
	}

	/** List the drive root — one entry per connected cloud. */
	async connections(): Promise<DavConnection[]> {
		const res = await this.req("PROPFIND", "", { headers: { Depth: "1" } });
		if (res.status !== 207) throw new Error(`PROPFIND /dav → ${res.status}`);
		return this.parseMultistatus(res.text)
			.filter((e) => e.isDir && e.name !== "")
			.map((e) => ({ slug: e.name, display: e.name }));
	}

	async list(path: string): Promise<DavEntry[]> {
		const res = await this.req("PROPFIND", path, {
			headers: { Depth: "1" },
			body: PROPFIND_BODY,
		});
		if (res.status === 404) return [];
		if (res.status !== 207)
			throw new Error(`PROPFIND ${path} → ${res.status}`);
		const depth = path.split("/").filter(Boolean).length;
		return this.parseMultistatus(res.text).filter((e) => {
			const rel = e.path.split("/").filter(Boolean).length;
			return rel > depth;             // children only, drop the self-entry
		}).map((e) => ({ ...e, path: this.rel(path, e.path) }));
	}

	/** Recursively list all files under path. */
	async walk(path: string): Promise<DavEntry[]> {
		const out: DavEntry[] = [];
		const stack = [path];
		while (stack.length) {
			const dir = stack.pop()!;
			for (const e of await this.list(dir)) {
				if (e.isDir) stack.push(this.join(dir, e.path));
				else out.push({ ...e, path: this.join(dir, e.path) });
			}
		}
		return out;
	}

	private rel(parent: string, full: string): string {
		const p = parent.split("/").filter(Boolean).length;
		return full.split("/").filter(Boolean).slice(p).join("/");
	}

	private join(parent: string, rel: string): string {
		return [parent, rel].filter(Boolean).join("/");
	}

	async ensureDir(path: string): Promise<void> {
		const segs = path.split("/").filter(Boolean);
		let cur = "";
		for (const s of segs) {
			cur = cur ? `${cur}/${s}` : s;
			const res = await this.req("MKCOL", cur);
			// 405 = already exists (WebDAV spec), 409 = parent missing — retry chain still works
			if (res.status >= 400 && ![405, 409].includes(res.status))
				throw new Error(`MKCOL ${cur} → ${res.status}`);
		}
	}

	async exists(path: string): Promise<boolean> {
		return !!(await this.stat(path));
	}

	async stat(path: string): Promise<DavEntry | null> {
		const res = await this.req("PROPFIND", path, {
			headers: { Depth: "0" }, body: PROPFIND_BODY,
		});
		if (res.status !== 207) return null;
		return this.parseMultistatus(res.text)[0] || null;
	}

	async put(path: string, data: ArrayBuffer): Promise<void> {
		const res = await this.req("PUT", path, { body: data });
		if (res.status >= 400) throw new Error(`PUT ${path} → ${res.status}`);
	}

	async get(path: string): Promise<ArrayBuffer> {
		const res = await this.req("GET", path);
		if (res.status !== 200) throw new Error(`GET ${path} → ${res.status}`);
		return res.arrayBuffer;
	}

	async delete(path: string): Promise<void> {
		const res = await this.req("DELETE", path);
		if (res.status !== 204 && res.status !== 200 && res.status !== 404)
			throw new Error(`DELETE ${path} → ${res.status}`);
	}

	async move(from: string, to: string): Promise<void> {
		const res = await requestUrl({
			url: this.url(from), method: "MOVE",
			headers: { Authorization: this.auth, Destination: this.url(to) },
			throw: false,
		});
		if (res.status >= 400) throw new Error(`MOVE ${from} → ${res.status}`);
	}

	async copy(from: string, to: string): Promise<void> {
		const res = await requestUrl({
			url: this.url(from), method: "COPY",
			headers: { Authorization: this.auth, Destination: this.url(to) },
			throw: false,
		});
		if (res.status >= 400) throw new Error(`COPY ${from} → ${res.status}`);
	}

	private parseMultistatus(xml: string): DavEntry[] {
		const doc = new DOMParser().parseFromString(xml, "text/xml");
		const out: DavEntry[] = [];
		for (const resp of byLocal(doc.documentElement, "response")) {
			const href = text(resp, "href");
			const props = byLocal(resp, "prop")[0];
			if (!href || !props) continue;
			const path = decodeURIComponent(href)
				.replace(/^\/+dav\/+/, "").replace(/\/+$/, "");
			const name = text(props, "displayname")
				|| path.split("/").pop() || "";
			const isDir = byLocal(props, "collection").length > 0;
			out.push({
				path, name, isDir,
				size: parseInt(text(props, "getcontentlength") || "0", 10) || 0,
				mtime: Date.parse(text(props, "getlastmodified") || "") || 0,
				etag: text(props, "getetag"),
			});
		}
		return out;
	}
}

const PROPFIND_BODY =
	`<?xml version="1.0" encoding="utf-8"?>` +
	`<d:propfind xmlns:d="DAV:"><d:prop>` +
	`<d:displayname/><d:resourcetype/><d:getcontentlength/>` +
	`<d:getlastmodified/><d:getetag/>` +
	`</d:prop></d:propfind>`;

/** Namespace-agnostic lookup — real DOMParser gives localName="x",
 *  lightweight ones (linkedom) keep the "d:x" prefix in tagName. */
function byLocal(el: Element, local: string): Element[] {
	return Array.from(el.querySelectorAll("*")).filter(
		(e) => e.localName === local || e.tagName === local ||
			e.tagName.endsWith(`:${local}`));
}

function text(el: Element, local: string): string {
	const n = byLocal(el, local)[0];
	return n?.textContent?.trim() || "";
}
