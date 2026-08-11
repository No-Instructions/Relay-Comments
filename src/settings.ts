import { App, PluginSettingTab, Setting } from "obsidian";
import {
	RELAY_COMMENTS_BUILD_ID,
	RELAY_COMMENTS_VERSION,
} from "./buildInfo";
import type { IdentityProviderId } from "./identity/types";
import type RelayCommentsPlugin from "./main";

export {
	DEFAULT_SETTINGS,
	resolveSettings,
	type RelayCommentsSettings,
} from "./settings-data";

export class RelayCommentsSettingTab extends PluginSettingTab {
	private hasDisplayed = false;

	constructor(app: App, private plugin: RelayCommentsPlugin) {
		super(app, plugin);
	}

	display(): void {
		this.hasDisplayed = true;
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("relay-comments-settings-tab");
		this.renderIdentitySettings(containerEl);

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
			.setName("Comment preview on hover")
			.setDesc(
				"Show a floating preview when hovering commented text. Its links reply or open the thread in the sidebar.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.showHoverPreview)
					.onChange(async (value) => {
						this.plugin.settings.showHoverPreview = value;
						await this.plugin.saveSettingsAndRefresh();
					});
			});

		new Setting(containerEl)
			.setName("Inline action controls")
			.setDesc(
				"Show the add comment button on selection, and accept, reject, and resolve actions in hover previews.",
			)
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

	refreshIdentityProviderState(): void {
		if (this.hasDisplayed && this.containerEl.isConnected) {
			this.display();
		}
	}

	private renderIdentitySettings(containerEl: HTMLElement): void {
		const providers = this.plugin.getAvailableIdentityProviders();
		if (this.plugin.getRelayIdentitySupportStatus() === "unsupported") {
			const warning = containerEl.createDiv({
				cls: "relay-comments-identity-warning",
			});
			warning.createDiv({
				cls: "relay-comments-identity-warning-title",
				text: "Relay identity needs an update",
			});
			warning.createDiv({
				text: "Relay is installed, but this version does not support comment identities. Update Relay to use it as your identity provider.",
			});
		}

		if (providers.length > 1) {
			new Setting(containerEl)
				.setName("Identity provider")
				.setDesc(
					"Choose which service supplies your identity when you add comments.",
				)
				.addDropdown((dropdown) => {
					for (const provider of providers) {
						dropdown.addOption(provider.id, provider.name);
					}
					const selected =
						this.plugin.getSelectedIdentityProviderId() ?? providers[0].id;
					dropdown.setValue(selected).onChange(async (value) => {
						this.plugin.settings.identityProvider =
							value as IdentityProviderId;
						await this.plugin.saveSettingsAndRefresh();
					});
				});
		}

		if (providers.length > 0) return;

		new Setting(containerEl)
			.setName("Your name")
			.setDesc(
				"Written directly to the author field when you add a comment.",
			)
			.addText((text) => {
				text
					.setPlaceholder("Bongo Cat")
					.setValue(this.plugin.settings.authorName)
					.onChange(async (value) => {
						this.plugin.settings.authorName = value;
						await this.plugin.saveSettingsAndRefresh();
					});
			});

		new Setting(containerEl)
			.setName("Profile picture")
			.setDesc(
				"Optional image URL used for your avatar on this device. It is not written into Markdown.",
			)
			.addText((text) => {
				text
					.setPlaceholder("https://example.com/avatar.png")
					.setValue(this.plugin.settings.authorPicture)
					.onChange(async (value) => {
						this.plugin.settings.authorPicture = value;
						await this.plugin.saveSettingsAndRefresh();
					});
			});
	}

	private renderVersionLabel(containerEl: HTMLElement): void {
		const version = RELAY_COMMENTS_VERSION || "0.0.0";
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
