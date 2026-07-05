import { App, PluginSettingTab, Setting } from "obsidian";
import type RelayCommentsPlugin from "./main";

export {
	DEFAULT_SETTINGS,
	resolveSettings,
	type RelayCommentsSettings,
} from "./settings-data";

export class RelayCommentsSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: RelayCommentsPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Relay Comments" });

		new Setting(containerEl)
			.setName("Open sidebar when selecting comments")
			.setDesc(
				"When you select a comment in the note, open the review sidebar if it is not already open.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.openSidebarOnCommentSelect)
					.onChange(async (value) => {
						this.plugin.settings.openSidebarOnCommentSelect = value;
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
