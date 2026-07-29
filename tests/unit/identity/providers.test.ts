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
		const currentUser = createTestObservable({
			id: "relay-user",
			name: "Relay user",
			color: "#123456",
		});
		const users = createTestObservableMap([
			[
				"relay-user",
				{ id: "relay-user", name: "Resolved Relay user" },
			],
		]);
		const provider = new RelayIdentityProvider({
			plugins: {
				plugins: {
					"system3-relay": {
						api: {
							v0: {
								identity: {
									currentUser: currentUser.observable,
									users: users.observable,
								},
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

	it("subscribes after Relay announces its API and follows identity changes", () => {
		const currentUser = createTestObservable<{
			id: string;
			name: string;
		} | null>(null);
		const users = createTestObservableMap<string, {
			id: string;
			name: string;
		}>([]);
		const api = {
			v0: {
				identity: {
					currentUser: currentUser.observable,
					users: users.observable,
				},
			},
		};
		let apiReady: ((api: unknown) => void) | null = null;
		let offrefCalls = 0;
		const app = {
			plugins: { plugins: {} as Record<string, unknown> },
			workspace: {
				on: (_name: string, callback: (api: unknown) => void) => {
					apiReady = callback;
					return {};
				},
				offref: () => {
					offrefCalls += 1;
				},
			},
		};
		const provider = new RelayIdentityProvider(app as never);
		let changes = 0;
		const unsubscribe = provider.subscribe(() => {
			changes += 1;
		});

		app.plugins.plugins["system3-relay"] = { api };
		if (!apiReady) throw new Error("Relay API event was not registered");
		apiReady(api);
		expect(provider.isAvailable()).toBe(false);
		expect(changes).toBe(1);

		currentUser.emit({ id: "relay-user", name: "Relay user" });
		expect(provider.isAvailable()).toBe(true);
		users.set("relay-user", {
			id: "relay-user",
			name: "Updated Relay user",
		});
		expect(changes).toBe(3);

		unsubscribe();
		currentUser.emit(null);
		expect(changes).toBe(3);
		expect(offrefCalls).toBe(1);
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

function createTestObservable<T>(initial: T): {
	observable: {
		readonly value: T;
		subscribe(run: (value: T) => void): () => void;
	};
	emit(value: T): void;
} {
	let value = initial;
	const subscribers = new Set<(value: T) => void>();
	const observable = {
		get value(): T {
			return value;
		},
		subscribe(run: (value: T) => void): () => void {
			subscribers.add(run);
			return () => subscribers.delete(run);
		},
	};
	return {
		observable,
		emit(next: T): void {
			value = next;
			for (const subscriber of subscribers) subscriber(next);
		},
	};
}

function createTestObservableMap<K, V>(
	entries: [K, V][],
): {
	observable: {
		readonly value: unknown;
		get(key: K): V | undefined;
		subscribe(run: (value: unknown) => void): () => void;
	};
	set(key: K, value: V): void;
} {
	const values = new Map(entries);
	const subscribers = new Set<(value: unknown) => void>();
	const observable = {
		get value(): unknown {
			return observable;
		},
		get(key: K): V | undefined {
			return values.get(key);
		},
		subscribe(run: (value: unknown) => void): () => void {
			subscribers.add(run);
			return () => subscribers.delete(run);
		},
	};
	return {
		observable,
		set(key: K, value: V): void {
			values.set(key, value);
			for (const subscriber of subscribers) subscriber(observable);
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
