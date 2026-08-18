import { describe, expect, it, jest } from "@jest/globals";
import {
	ConfiguredIdentityResolver,
	getRelayIdentitySupportStatus,
	normalizeIdentity,
	normalizeSyncDirectory,
	ObsidianSyncIdentityProvider,
	RelayIdentityProvider,
	selectIdentityProvider,
	withConfiguredDecoration,
} from "src/identity/providers";

describe("configured decoration", () => {
	it("supplies the appearance a provider does not carry", () => {
		expect(
			withConfiguredDecoration(
				{ id: "u1", name: "Sarah Rilling" },
				{
					id: "u1",
					name: "whatever the directory calls them",
					picture: "https://example.com/sarah.jpg",
					color: "#30bced",
					colorLight: "#30bced33",
				},
			),
		).toEqual({
			id: "u1",
			// The provider stays authoritative about who this is.
			name: "Sarah Rilling",
			picture: "https://example.com/sarah.jpg",
			color: "#30bced",
			colorLight: "#30bced33",
		});
	});

	it("never overrides appearance a provider does carry", () => {
		expect(
			withConfiguredDecoration(
				{ id: "u1", name: "Sarah", picture: "provider.jpg", color: "#111111" },
				{
					id: "u1",
					name: "Sarah",
					picture: "configured.jpg",
					color: "#222222",
				},
			),
		).toMatchObject({ picture: "provider.jpg", color: "#111111" });
	});

	it("leaves an identity alone when the directory has no entry", () => {
		const identity = { id: "u1", name: "Sarah" };

		expect(withConfiguredDecoration(identity, null)).toEqual(identity);
	});

	it("fills each field independently", () => {
		// A directory entry that only sets a colour must not blank out a picture, and vice versa.
		expect(
			withConfiguredDecoration(
				{ id: "u1", name: "Sarah", picture: "provider.jpg" },
				{ id: "u1", name: "Sarah", color: "#30bced" },
			),
		).toEqual({
			id: "u1",
			name: "Sarah",
			picture: "provider.jpg",
			color: "#30bced",
			colorLight: undefined,
		});
	});
});

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
							v0: {
								getCurrentUser: () => ({
									id: "relay-user",
									name: "Relay user",
									color: "#123456",
								}),
								getUsers: () => [
									{
										id: "relay-user",
										name: "Resolved Relay user",
									},
								],
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
			color: "#123456",
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

	it("snapshots after Relay's payload-free ready event and applies deltas", async () => {
		let currentUser: { id: string; name: string } | null = null;
		let users: { id: string; name: string }[] = [];
		const api = {
			v0: {
				getCurrentUser: () => currentUser,
				getUsers: () => users,
			},
		};
		const workspace = createTestWorkspace();
		const app = {
			plugins: { plugins: {} as Record<string, unknown> },
			workspace,
		};
		const provider = new RelayIdentityProvider(app as never);
		let changes = 0;
		const unsubscribe = provider.subscribe(() => {
			changes += 1;
		});

		app.plugins.plugins["system3-relay"] = { api };
		workspace.emit("system3-relay:api-ready");
		expect(provider.isAvailable()).toBe(false);
		expect(changes).toBe(1);

		currentUser = { id: "relay-user", name: "Relay user" };
		workspace.emit("system3-relay:v0:current-user", {
			action: "update",
			record: currentUser,
		});
		expect(provider.isAvailable()).toBe(true);
		await expect(provider.getCurrentUser("shared.md")).resolves.toEqual(
			currentUser,
		);

		workspace.emit("system3-relay:v0:users", {
			action: "create",
			record: { id: "relay-user", name: "Relay user" },
		});
		expect(changes).toBe(3);
		await expect(provider.resolveUser("relay-user", "shared.md")).resolves.toEqual({
			id: "relay-user",
			name: "Relay user",
		});

		workspace.emit("system3-relay:v0:users", {
			action: "update",
			record: { id: "relay-user", name: "Updated Relay user" },
		});
		await expect(provider.resolveUser("relay-user", "shared.md")).resolves.toEqual({
			id: "relay-user",
			name: "Updated Relay user",
		});

		workspace.emit("system3-relay:v0:users", {
			action: "delete",
			record: { id: "relay-user", name: "Updated Relay user" },
		});
		await expect(
			provider.resolveUser("relay-user", "shared.md"),
		).resolves.toBeNull();

		users = [{ id: "stale-user", name: "Old facade user" }];
		app.plugins.plugins["system3-relay"] = {
			api: {
				v0: {
					getCurrentUser: () => currentUser,
					getUsers: () => [
						{ id: "other-user", name: "Snapshot user" },
					],
				},
			},
		};
		workspace.emit("system3-relay:api-ready");
		await expect(provider.resolveUser("other-user", "shared.md")).resolves.toEqual({
			id: "other-user",
			name: "Snapshot user",
		});
		await expect(
			provider.resolveUser("stale-user", "shared.md"),
		).resolves.toBeNull();

		unsubscribe();
		const changesAtUnsubscribe = changes;
		workspace.emit("system3-relay:v0:current-user", {
			action: "update",
			record: null,
		});
		expect(changes).toBe(changesAtUnsubscribe);
		expect(workspace.offrefCalls).toBe(3);
	});

	it("publishes cached identity stores and retains them across Relay absence", async () => {
		const bongo = { id: "bongo", name: "Bongo Cat" };
		const updatedBongo = { ...bongo, name: "Bongo Cat Jr." };
		const workspace = createTestWorkspace();
		const relay = {
			api: {
				v0: {
					getCurrentUser: () => bongo,
					getUsers: () => [bongo],
				},
			},
		};
		const provider = new RelayIdentityProvider({
			plugins: { plugins: { "system3-relay": relay } },
			workspace,
		} as never);
		const users = jest.fn();
		const currentUser = jest.fn();

		provider.subscribe(() => {});
		provider.users.subscribe(users);
		provider.currentUser.subscribe(currentUser);

		expect(users).toHaveBeenLastCalledWith(provider.users);
		expect(provider.users.get("bongo")).toEqual(bongo);
		expect(currentUser).toHaveBeenLastCalledWith(bongo);

		relay.api = undefined as never;
		workspace.emit("system3-relay:api-ready");
		expect(provider.resolveUserSnapshot("bongo", "note.md")).toEqual(bongo);
		expect(provider.getCurrentUserSnapshot("note.md")).toEqual(bongo);

		relay.api = {
			v0: {
				getCurrentUser: () => updatedBongo,
				getUsers: () => [updatedBongo],
			},
		};
		workspace.emit("system3-relay:api-ready");
		expect(provider.users.get("bongo")).toEqual(updatedBongo);
		expect(provider.currentUser.value).toEqual(updatedBongo);
		expect(users).toHaveBeenCalledTimes(2);
		expect(currentUser).toHaveBeenCalledTimes(2);
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

function createTestWorkspace(): {
	on(name: string, callback: (...args: unknown[]) => void): object;
	offref(ref: object): void;
	emit(name: string, ...args: unknown[]): void;
	offrefCalls: number;
} {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	const refs = new Map<object, { name: string; callback: (...args: unknown[]) => void }>();
	return {
		offrefCalls: 0,
		on(name, callback): object {
			const ref = {};
			const callbacks = listeners.get(name) ?? new Set();
			callbacks.add(callback);
			listeners.set(name, callbacks);
			refs.set(ref, { name, callback });
			return ref;
		},
		offref(ref): void {
			this.offrefCalls += 1;
			const entry = refs.get(ref);
			if (!entry) return;
			listeners.get(entry.name)?.delete(entry.callback);
			refs.delete(ref);
		},
		emit(name, ...args): void {
			for (const callback of listeners.get(name) ?? []) callback(...args);
		},
	};
}

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
