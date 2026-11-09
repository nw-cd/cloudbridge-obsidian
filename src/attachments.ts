import { Notice } from "obsidian";
import type CloudBridgePlugin from "./main";
import { DavClient } from "./dav";
import { ApiClient } from "./api";
import { resolveSlug } from "./sync";

const EMBED_RE = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\(([^)]+)\)/g;
const IMAGE_EXT = /^(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/i;

/**
 * Find local attachments embedded in the active note, upload each to
 * <remoteFolder>/_attachments/, create a public share link and rewrite
 * the embed to point at the cloud URL. Images get the direct-download
 * URL so they render inline; other files get the share page.
 */
export async function uploadNoteAttachments(
	plugin: CloudBridgePlugin): Promise<void> {
	const s = plugin.settings;
	const file = plugin.app.workspace.getActiveFile();
	if (!file) {
		new Notice("CloudBridge: открой заметку");
		return;
	}
	if (!s.apiKey || !s.connectionId) {
		new Notice("CloudBridge: set API key and cloud in settings");
		return;
	}

	let text = await plugin.app.vault.read(file);
	const refs: { raw: string; path: string }[] = [];
	for (const m of text.matchAll(EMBED_RE)) {
		const p = decodeURIComponent(m[1] || m[2] || "");
		if (!p || /^https?:\/\//.test(p)) continue;
		refs.push({ raw: m[0], path: p });
	}
	if (!refs.length) {
		new Notice("CloudBridge: локальных вложений не найдено");
		return;
	}

	const dav = new DavClient(s.serverUrl, s.apiKey);
	const api = new ApiClient(s.serverUrl, s.apiKey);
	const slug = await resolveSlug(dav, s);
	const dir = `${slug}/${s.remoteFolder}/_attachments`;
	await dav.ensureDir(dir);

	let done = 0;
	for (const ref of refs) {
		const local = plugin.app.metadataCache
			.getFirstLinkpathDest(ref.path, file.path);
		if (!local) continue;
		const data = await plugin.app.vault.readBinary(local);
		const name = local.name;
		await dav.put(`${dir}/${name}`, data);

		// resolve provider key for the share link via REST listing
		const listed = await api.files(s.connectionId,
			`${s.remoteFolder}/_attachments`);
		const remote = listed.find((f) => f.name === name);
		if (!remote) continue;
		const link = await api.shareLink(s.connectionId, remote);

		const isImage = IMAGE_EXT.test(name.split(".").pop() || "");
		const repl = isImage
			? `![${name}](${link.download})`
			: `[${name}](${link.page})`;
		text = text.replace(ref.raw, repl);
		done++;
	}
	if (done) await plugin.app.vault.modify(file, text);
	new Notice(`CloudBridge: ${done} вложений загружено`);
}
