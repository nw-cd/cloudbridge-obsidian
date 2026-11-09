import { requestUrl } from "obsidian";

export interface Connection {
	id: number;
	provider: string;
	account_email?: string;
	account_name?: string;
	dav_slug?: string;   // authoritative /dav/ folder name from the server
	storage_quota_total: number;
	storage_quota_used: number;
}

export interface RemoteFile {
	key: string;
	name: string;
	rel_path: string;
	is_dir: boolean;
	size: number;
	modified?: string;
	mime_type?: string;
}

/** Thin REST client for /api/v1 — everything that /dav can't do
 *  (connection picker, provider keys for share-links). */
export class ApiClient {
	constructor(private base: string, private apiKey: string) {
		this.base = base.replace(/\/+$/, "");
	}

	private async req<T>(method: string, path: string,
	                     body?: unknown): Promise<T> {
		const res = await requestUrl({
			url: `${this.base}/api/v1${path}`,
			method,
			headers: {
				"X-API-Key": this.apiKey,
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
			throw: false,
		});
		if (res.status >= 400) {
			let msg = `${res.status}`;
			const body = res.json as { detail?: string } | undefined;
			if (body?.detail) msg = body.detail;
			throw new Error(`API ${method} ${path} → ${msg}`);
		}
		return res.json as T;
	}

	connections(): Promise<Connection[]> {
		return this.req("GET", "/connections");
	}

	files(connectionId: number, path: string): Promise<RemoteFile[]> {
		return this.req("GET",
			`/files?connection_id=${connectionId}&path=${encodeURIComponent(path)}`);
	}

	async shareLink(connectionId: number, f: RemoteFile):
		Promise<{ page: string; download: string }> {
		const out = await this.req<{ url: string; token: string }>(
			"POST", "/share-links", {
			kind: "file",
			connection_id: connectionId,
			key: f.key,
			name: f.name,
			mime_type: f.mime_type,
			size: f.size,
			ttl_days: 0,
		});
		return {
			page: out.url,
			download: `${this.base}/api/share/s/${out.token}/download`,
		};
	}
}
