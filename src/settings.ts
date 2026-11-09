import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CloudBridgePlugin from "./main";
import { ApiClient, Connection } from "./api";

export interface FileState {
	mtime: number;
	size: number;
	remote_mtime?: number;
}

export interface CloudBridgeSettings {
	serverUrl: string;
	apiKey: string;
	connectionId: number;
	connectionLabel: string;   // cached "dropbox — me@x.com" — for display
	connectionSlug: string;    // exact /dav/ folder name — set on cloud pick
	remoteFolder: string;
	syncIntervalMin: number;   // 0 = manual only
	syncOnSave: boolean;
	twoWay: boolean;           // also pull remote changes
	propagateDeletes: boolean;
	includeHidden: boolean;    // .obsidian, .trash and friends
	lastSync: number;
	syncState: Record<string, FileState>;
}

export const DEFAULT_SETTINGS: CloudBridgeSettings = {
	serverUrl: "https://cloud-bridge.ru",
	apiKey: "",
	connectionId: 0,
	connectionLabel: "",
	connectionSlug: "",
	remoteFolder: "Obsidian",
	syncIntervalMin: 15,
	syncOnSave: true,
	twoWay: true,
	propagateDeletes: false,
	includeHidden: false,
	lastSync: 0,
	syncState: {},
};

export class CloudBridgeSettingTab extends PluginSettingTab {
	conns: Connection[] = [];

	constructor(app: App, private plugin: CloudBridgePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName("CloudBridge").setHeading();

		new Setting(containerEl)
			.setName("Server")
			.setDesc("CloudBridge instance URL.")
			.addText((t) => t
				.setPlaceholder("https://cloud-bridge.ru")
				.setValue(s.serverUrl)
				.onChange(async (v) => {
					s.serverUrl = v.trim().replace(/\/+$/, "");
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Create one in CloudBridge → Dashboard → API. Needs the API add-on.")
			.addText((t) => {
				t.setPlaceholder("cb_live_…")
					.setValue(s.apiKey)
					.onChange(async (v) => {
						s.apiKey = v.trim();
						await this.plugin.saveSettings();
					});
				t.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Connection")
			.setDesc("Test the key, then pick the cloud this vault syncs to.")
			.addButton((b) => b.setButtonText("Fetch clouds")
				.onClick(async () => {
					try {
						this.conns = await new ApiClient(
							s.serverUrl, s.apiKey).connections();
						new Notice(`CloudBridge: ${this.conns.length} clouds`);
						this.display();
					} catch (e) {
						new Notice(`CloudBridge: ${(e as Error).message}`);
					}
				}))
			.addDropdown((d) => {
				for (const c of this.conns) {
					const label = `${c.provider} — ${c.account_email || c.account_name || "#" + c.id}`;
					d.addOption(String(c.id), label);
				}
				if (s.connectionLabel && !this.conns.length)
					d.addOption(String(s.connectionId), s.connectionLabel);
				d.setValue(String(s.connectionId || ""))
					.onChange(async (v) => {
						s.connectionId = parseInt(v, 10) || 0;
						const c = this.conns.find((x) => x.id === s.connectionId);
						s.connectionLabel = c
							? `${c.provider} — ${c.account_email || "#" + c.id}`
							: s.connectionLabel;
						s.connectionSlug = c?.dav_slug || "";
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Remote folder")
			.setDesc("Folder created in the cloud root — the vault mirrors into it.")
			.addText((t) => t.setValue(s.remoteFolder)
				.onChange(async (v) => {
					s.remoteFolder = v.trim().replace(/^\/+|\/+$/g, "") || "Obsidian";
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc("0 = manual sync only.")
			.addText((t) => t.setValue(String(s.syncIntervalMin))
				.onChange(async (v) => {
					s.syncIntervalMin = Math.max(0, parseInt(v, 10) || 0);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Sync on save")
			.setDesc("Push a file to the cloud a few seconds after editing.")
			.addToggle((t) => t.setValue(s.syncOnSave)
				.onChange(async (v) => {
					s.syncOnSave = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Two-way sync")
			.setDesc("Also pull files that changed in the cloud (e.g. from another device).")
			.addToggle((t) => t.setValue(s.twoWay)
				.onChange(async (v) => {
					s.twoWay = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Propagate deletions")
			.setDesc("Deleting a file on one side deletes it on the other. Off = deletions are re-downloaded/re-uploaded instead.")
			.addToggle((t) => t.setValue(s.propagateDeletes)
				.onChange(async (v) => {
					s.propagateDeletes = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Sync hidden folders")
			.setDesc("Include .obsidian config and other dot-folders. Off by default — safer.")
			.addToggle((t) => t.setValue(s.includeHidden)
				.onChange(async (v) => {
					s.includeHidden = v;
					await this.plugin.saveSettings();
				}));
	}
}
