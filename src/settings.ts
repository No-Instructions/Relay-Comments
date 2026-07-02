import { App, PluginSettingTab, Setting } from "obsidian";
import type CriticMarkupPlugin from "./main";
import type { DisplayMode } from "./critic/types";

export interface CriticMarkupSettings {
	defaultDisplayMode: DisplayMode;
	showAuthorChips: boolean;
	showInlineActions: boolean;
	enableReviewSidebar: boolean;
	noteDisplayModes: Record<string, DisplayMode>;
}

export const DEFAULT_SETTINGS: CriticMarkupSettings = {
	defaultDisplayMode: "review",
	showAuthorChips: true,
	showInlineActions: true,
	enableReviewSidebar: true,
	noteDisplayModes: {},
};

export class CriticMarkupSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: CriticMarkupPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "CriticMarkup" });

		new Setting(containerEl)
			.setName("Default display mode")
			.setDesc("Review shows suggestions, clean previews accepted text, raw shows source markup.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("review", "Review")
					.addOption("clean", "Clean")
					.addOption("raw", "Raw")
					.setValue(this.plugin.settings.defaultDisplayMode)
					.onChange(async (value) => {
						this.plugin.settings.defaultDisplayMode = value as DisplayMode;
						await this.plugin.saveSettingsAndRefresh();
					});
			});

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
