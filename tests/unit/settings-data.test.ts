import { describe, expect, it } from "@jest/globals";
import { DEFAULT_SETTINGS, resolveSettings } from "src/settings-data";

describe("resolveSettings", () => {
	it("returns defaults for missing or empty data", () => {
		expect(resolveSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(resolveSettings({})).toEqual(DEFAULT_SETTINGS);
	});

	it("keeps explicit values", () => {
		expect(
			resolveSettings({
				showInlineActions: false,
				openSidebarOnCommentSelect: false,
				showHoverPreview: false,
				identityProvider: "obsidian-sync",
				identities: [{ id: "architect", name: "Architecture reviewer" }],
				authorName: " Bongo Cat ",
				authorPicture: " https://example.com/bongo.png ",
			}),
		).toEqual({
			showInlineActions: false,
			openSidebarOnCommentSelect: false,
			showHoverPreview: false,
			identityProvider: "obsidian-sync",
			identities: [{ id: "architect", name: "Architecture reviewer" }],
			authorName: "Bongo Cat",
			authorPicture: "https://example.com/bongo.png",
		});
	});

	it("defaults the hover preview on for data saved before it existed", () => {
		expect(
			resolveSettings({ showInlineActions: true }).showHoverPreview,
		).toBe(true);
	});

	it("ignores keys dropped from older versions", () => {
		expect(resolveSettings({ showAuthorChips: false })).toEqual(
			DEFAULT_SETTINGS,
		);
	});

	it("migrates the pre-0.2 enableReviewSidebar value", () => {
		expect(
			resolveSettings({ enableReviewSidebar: false }).openSidebarOnCommentSelect,
		).toBe(false);
		expect(
			resolveSettings({ enableReviewSidebar: true }).openSidebarOnCommentSelect,
		).toBe(true);
	});

	it("prefers the new key over the legacy key", () => {
		expect(
			resolveSettings({
				openSidebarOnCommentSelect: true,
				enableReviewSidebar: false,
			}).openSidebarOnCommentSelect,
		).toBe(true);
		expect(
			resolveSettings({
				openSidebarOnCommentSelect: false,
				enableReviewSidebar: true,
			}).openSidebarOnCommentSelect,
		).toBe(false);
	});

	it("normalizes configured identities from data.json", () => {
		expect(
			resolveSettings({
				identities: [
					{
						id: " architect ",
						name: " Architecture reviewer ",
						picture: " avatar.png ",
						color: " #123456 ",
						colorLight: "",
						extra: "ignored",
					},
					{ id: "architect", name: "Duplicate" },
					{ id: "", name: "Missing id" },
					null,
				],
			}),
		).toMatchObject({
			identityProvider: null,
			identities: [
				{
					id: "architect",
					name: "Architecture reviewer",
					picture: "avatar.png",
					color: "#123456",
				},
			],
		});
	});

	it("falls back from unknown provider and malformed identities", () => {
		expect(
			resolveSettings({
				identityProvider: "unknown",
				identities: "not-an-array",
				authorName: 42,
				authorPicture: {},
			}),
		).toMatchObject({
			identityProvider: null,
			identities: [],
			authorName: "",
			authorPicture: "",
		});
	});
});
