import { App, PluginSettingTab, Setting } from "obsidian";
import type RelayCommentsPlugin from "./main";

export interface RelayCommentsSettings {
	showAuthorChips: boolean;
	showInlineActions: boolean;
	enableReviewSidebar: boolean;
}

export const DEFAULT_SETTINGS: RelayCommentsSettings = {
	showAuthorChips: true,
	showInlineActions: true,
	enableReviewSidebar: true,
};

export class RelayCommentsSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: RelayCommentsPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Relay Comments" });

		new Setting(containerEl)
			.setName("Review sidebar")
			.setDesc("Enable the document-scoped sidebar for comments and suggestions.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.enableReviewSidebar)
					.onChange(async (value) => {
						this.plugin.settings.enableReviewSidebar = value;
						await this.plugin.saveSettingsAndRefresh();
					});
			});

		new Setting(containerEl)
			.setName("Inline action controls")
			.setDesc("Show inline editor controls for comments and suggestions.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.showInlineActions)
					.onChange(async (value) => {
						this.plugin.settings.showInlineActions = value;
						await this.plugin.saveSettingsAndRefresh();
					});
			});
	}
}
