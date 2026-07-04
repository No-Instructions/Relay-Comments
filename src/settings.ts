import { App, PluginSettingTab, Setting } from "obsidian";
import { RELAY_COMMENTS_BUILD_ID } from "./buildInfo";
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
		containerEl.addClass("relay-comments-settings-tab");
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

		this.renderVersionLabel(containerEl);
	}

	private renderVersionLabel(containerEl: HTMLElement): void {
		const version = this.plugin.manifest.version || "0.0.0";
		const buildId = RELAY_COMMENTS_BUILD_ID || "dev";
		const label = `${version} · ${buildId}`;

		containerEl.createDiv({
			cls: "relay-comments-settings-version",
			text: label,
			attr: {
				"aria-label": `Relay Comments version ${version}, build ${buildId}`,
				title: `Relay Comments ${label}`,
			},
		});
	}
}
