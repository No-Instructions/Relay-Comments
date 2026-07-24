import { describe, expect, it } from "@jest/globals";
import {
	ConfiguredIdentityResolver,
	getRelayIdentitySupportStatus,
	normalizeIdentity,
	normalizeSyncDirectory,
	ObsidianSyncIdentityProvider,
	RelayIdentityProvider,
	selectIdentityProvider,
} from "src/identity/providers";

describe("configured identity directory", () => {
	it("resolves other authors without acting as the current user", async () => {
		const provider = new ConfiguredIdentityResolver(() => [
			{ id: "architect", name: "Architecture reviewer" },
			{ id: "copy-editor", name: "Copy editor" },
		]);

		await expect(
			provider.resolveUser("architect", "note.md"),
		).resolves.toEqual({
			id: "architect",
			name: "Architecture reviewer",
		});
		await expect(
			provider.resolveUser("unknown", "note.md"),
		).resolves.toBeNull();
	});
});

describe("identity normalization", () => {
	it("requires an id and name", () => {
		expect(normalizeIdentity({ id: 42, name: "Sync user" })).toEqual({
			id: "42",
			name: "Sync user",
		});
		expect(normalizeIdentity({ id: "missing-name" })).toBeNull();
	});

	it("accepts common Obsidian Sync directory shapes", () => {
		expect(
			Array.from(
				normalizeSyncDirectory({
					"12": "Daniel",
					"34": { name: "Reviewer", avatar: "avatar.png" },
				}).values(),
			),
		).toEqual([
			{ id: "12", name: "Daniel" },
			{ id: "34", name: "Reviewer", picture: "avatar.png" },
		]);

		expect(
			normalizeSyncDirectory({
				users: [{ id: 56, displayName: "Agent" }],
			}).get("56"),
		).toEqual({ id: "56", name: "Agent" });
	});
});

describe("service identity providers", () => {
	it("uses Relay's public plugin API without reading Relay internals", async () => {
		const provider = new RelayIdentityProvider({
			plugins: {
				plugins: {
					"system3-relay": {
						api: {
							version: 1,
							identity: {
								getCurrentUser: async (path: string) =>
									path === "shared.md"
										? { id: "relay-user", name: "Relay user" }
										: null,
								resolveUser: async (id: string) => ({
									id,
									name: "Resolved Relay user",
								}),
							},
						},
					},
				},
			},
		} as never);

		expect(provider.isAvailable()).toBe(true);
		await expect(provider.getCurrentUser("shared.md")).resolves.toEqual({
			id: "relay-user",
			name: "Relay user",
		});
		await expect(
			provider.resolveUser("relay-user", "shared.md"),
		).resolves.toEqual({
			id: "relay-user",
			name: "Resolved Relay user",
		});
	});

	it("reports an installed Relay without the public identity API", () => {
		expect(
			getRelayIdentitySupportStatus({
				plugins: {
					plugins: {
						"system3-relay": {},
					},
				},
			} as never),
		).toBe("unsupported");
		expect(
			getRelayIdentitySupportStatus({
				plugins: { plugins: {} },
			} as never),
		).toBe("not-installed");
	});

	it("resolves the numeric Obsidian Sync user ID through its directory", async () => {
		const provider = new ObsidianSyncIdentityProvider({
			internalPlugins: {
				plugins: {
					sync: {
						enabled: true,
						instance: {
							userId: 42,
							getUsernames: async () => ({ "42": "Sync user" }),
						},
					},
				},
			},
		} as never);

		expect(provider.isAvailable()).toBe(true);
		await expect(provider.getCurrentUser("note.md")).resolves.toEqual({
			id: "42",
			name: "Sync user",
		});
	});
});

describe("identity provider selection", () => {
	const relay = {
		id: "relay" as const,
		name: "Relay",
		isAvailable: () => true,
		getCurrentUser: async () => null,
		resolveUser: async () => null,
	};
	const sync = {
		id: "obsidian-sync" as const,
		name: "Obsidian Sync",
		isAvailable: () => true,
		getCurrentUser: async () => null,
		resolveUser: async () => null,
	};

	it("uses an explicit available provider", () => {
		expect(selectIdentityProvider([relay, sync], "obsidian-sync")).toBe(sync);
	});

	it("uses the first available provider without an automatic mode", () => {
		expect(selectIdentityProvider([relay, sync], null)).toBe(relay);
	});

	it("skips unavailable providers", () => {
		const unavailableRelay = { ...relay, isAvailable: () => false };
		expect(selectIdentityProvider([unavailableRelay, sync], "relay")).toBe(sync);
	});
});
