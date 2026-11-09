import { Plugin } from "obsidian";
import {
	CloudBridgeSettings, CloudBridgeSettingTab, DEFAULT_SETTINGS,
} from "./settings";
import { SyncEngine } from "./sync";
import { uploadNoteAttachments } from "./attachments";

export default class CloudBridgePlugin extends Plugin {
	settings: CloudBridgeSettings;
	sync: SyncEngine;
	private statusEl: HTMLElement;
	private debounce: number | null = null;

	async onload() {
		await this.loadSettings();
		this.sync = new SyncEngine(this);
		this.addSettingTab(new CloudBridgeSettingTab(this.app, this));

		this.statusEl = this.addStatusBarItem();
		this.setStatus("·");

		this.addRibbonIcon("cloud", "CloudBridge: sync now",
			() => this.sync.run("manual"));

		this.addCommand({
			id: "cloudbridge-sync",
			name: "Sync vault now",
			callback: () => this.sync.run("manual"),
		});
		this.addCommand({
			id: "cloudbridge-upload-attachments",
			name: "Upload note attachments to cloud",
			callback: () => uploadNoteAttachments(this),
		});

		if (this.settings.syncOnSave) {
			this.registerEvent(this.app.vault.on("modify", (f) => {
				if (f.path) this.sync.onLocalChange(f.path);
			}));
		}

		this.registerInterval(window.setInterval(() => {
			if (this.due()) this.sync.run("timer");
		}, 30_000));
	}

	private due(): boolean {
		const s = this.settings;
		if (!s.apiKey || !s.connectionId) return false;
		if (this.debounce !== null) return true;
		if (!s.syncIntervalMin) return false;
		return Date.now() - s.lastSync >= s.syncIntervalMin * 60_000;
	}

	/** Debounced sync after local edits (≈8 s quiet period). */
	scheduleSync(): void {
		if (this.debounce !== null) window.clearTimeout(this.debounce);
		this.debounce = window.setTimeout(() => {
			this.debounce = null;
			this.sync.run("auto");
		}, 8_000);
	}

	setStatus(text: string): void {
		this.statusEl?.setText(`CloudBridge ${text}`);
	}

	async loadSettings() {
		this.settings = Object.assign(
			{}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
