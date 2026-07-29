import type { App, EventRef } from "obsidian";
import type {
	Identity,
	IdentityProvider,
	IdentityProviderId,
	IdentityProviderSetting,
	IdentityResolver,
} from "./types";

interface RelayObservableLike<T> {
	readonly value: T;
	subscribe(run: (value: T) => void): () => void;
}

interface RelayObservableMapLike<K, V>
	extends RelayObservableLike<RelayObservableMapLike<K, V>> {
	get(key: K): V | undefined;
}

interface RelayIdentityApiLike {
	users: RelayObservableMapLike<string, IdentityLike>;
	currentUser: RelayObservableLike<IdentityLike | null>;
}

interface RelayPluginLike {
	api?: unknown;
}

interface IdentityLike {
	id?: unknown;
	name?: unknown;
	picture?: unknown;
	color?: unknown;
	colorLight?: unknown;
}

interface ObsidianSyncLike {
	userId?: unknown;
	getUsernames?(): Promise<unknown>;
}

interface ObsidianSyncPluginLike {
	enabled?: boolean;
	instance?: ObsidianSyncLike;
}

interface AppWithPlugins extends App {
	plugins?: {
		plugins?: Record<string, unknown>;
	};
	internalPlugins?: {
		plugins?: Record<string, unknown>;
	};
}

export function createIdentityProviders(
	app: App,
): IdentityProvider[] {
	return [
		new RelayIdentityProvider(app),
		new ObsidianSyncIdentityProvider(app),
	];
}

export class ConfiguredIdentityResolver implements IdentityResolver {
	readonly id = "configured";
	readonly name = "Identity directory";

	constructor(private readonly getIdentities: () => Identity[]) {}

	isAvailable(): boolean {
		return this.getIdentities().length > 0;
	}

	async resolveUser(id: string, _path: string): Promise<Identity | null> {
		return this.getIdentities().find((identity) => identity.id === id) ?? null;
	}
}

export type RelayIdentitySupportStatus =
	| "not-installed"
	| "unsupported"
	| "available";

const RELAY_API_READY_EVENT = "system3-relay:api-ready";

export function getRelayIdentitySupportStatus(
	app: App,
): RelayIdentitySupportStatus {
	const plugin = getRelayPlugin(app);
	if (!plugin) return "not-installed";
	return getRelayIdentityApi(plugin.api) ? "available" : "unsupported";
}

export class RelayIdentityProvider implements IdentityProvider {
	readonly id = "relay";
	readonly name = "Relay";

	constructor(private readonly app: App) {}

	isAvailable(): boolean {
		const api = this.getApi();
		return Boolean(api && normalizeIdentity(api.currentUser.value));
	}

	async getCurrentUser(_path: string): Promise<Identity | null> {
		const api = this.getApi();
		if (!api) return null;
		return normalizeIdentity(api.currentUser.value);
	}

	async resolveUser(id: string, _path: string): Promise<Identity | null> {
		const api = this.getApi();
		if (!api) return null;
		return normalizeIdentity(api.users.get(id) ?? null);
	}

	subscribe(onChange: () => void): () => void {
		let detachApi = () => {};
		const attach = (api: unknown): void => {
			detachApi();
			detachApi = () => {};
			const identity = getRelayIdentityApi(api);
			if (identity) {
				const unsubscribeCurrentUser =
					identity.currentUser.subscribe(onChange);
				const unsubscribeUsers = identity.users.subscribe(onChange);
				detachApi = () => {
					unsubscribeCurrentUser();
					unsubscribeUsers();
				};
			}
			onChange();
		};

		const plugin = getRelayPlugin(this.app);
		if (plugin?.api) attach(plugin.api);

		const eventRef = (
			this.app.workspace as unknown as {
				on(
					name: typeof RELAY_API_READY_EVENT,
					callback: (api: unknown) => void,
				): EventRef;
			}
		).on(RELAY_API_READY_EVENT, attach);

		return () => {
			detachApi();
			this.app.workspace.offref(eventRef);
		};
	}

	private getApi(): RelayIdentityApiLike | null {
		return getRelayIdentityApi(getRelayPlugin(this.app)?.api);
	}
}

export class ObsidianSyncIdentityProvider implements IdentityProvider {
	readonly id = "obsidian-sync";
	readonly name = "Obsidian Sync";
	private directory: Map<string, Identity> | null = null;
	private directoryRequest: Promise<Map<string, Identity>> | null = null;

	constructor(private readonly app: App) {}

	isAvailable(): boolean {
		const plugin = this.getPlugin();
		return Boolean(
			plugin?.enabled &&
				plugin.instance &&
				normalizeId(plugin.instance.userId) !== null,
		);
	}

	async getCurrentUser(_path: string): Promise<Identity | null> {
		const id = normalizeId(this.getPlugin()?.instance?.userId);
		if (id === null) return null;
		return this.resolveUser(id, _path);
	}

	async resolveUser(id: string, _path: string): Promise<Identity | null> {
		const directory = await this.getDirectory();
		return directory.get(id) ?? null;
	}

	private getPlugin(): ObsidianSyncPluginLike | null {
		return (
			((this.app as AppWithPlugins).internalPlugins?.plugins?.sync as
				| ObsidianSyncPluginLike
				| undefined) ?? null
		);
	}

	private async getDirectory(): Promise<Map<string, Identity>> {
		if (this.directory) return this.directory;
		if (this.directoryRequest) return this.directoryRequest;

		const request = (async () => {
			const getUsernames = this.getPlugin()?.instance?.getUsernames;
			if (!getUsernames) return new Map<string, Identity>();
			try {
				return normalizeSyncDirectory(await getUsernames.call(
					this.getPlugin()?.instance,
				));
			} catch {
				return new Map<string, Identity>();
			}
		})();
		this.directoryRequest = request;
		this.directory = await request;
		this.directoryRequest = null;
		return this.directory;
	}
}

export function normalizeIdentity(value: IdentityLike | null): Identity | null {
	if (!value) return null;
	const id = normalizeId(value.id);
	const name = normalizeString(value.name);
	if (id === null || !name) return null;
	return {
		id,
		name,
		...optionalString("picture", value.picture),
		...optionalString("color", value.color),
		...optionalString("colorLight", value.colorLight),
	};
}

export function normalizeSyncDirectory(value: unknown): Map<string, Identity> {
	const identities = new Map<string, Identity>();
	addSyncDirectoryValue(identities, value);
	return identities;
}

function addSyncDirectoryValue(
	identities: Map<string, Identity>,
	value: unknown,
	keyHint?: string,
): void {
	if (value instanceof Map) {
		for (const [key, entry] of value) {
			addSyncDirectoryValue(identities, entry, String(key));
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			if (Array.isArray(entry) && entry.length >= 2) {
				addSyncDirectoryValue(identities, entry[1], String(entry[0]));
			} else {
				addSyncDirectoryValue(identities, entry);
			}
		}
		return;
	}
	if (typeof value === "string") {
		if (keyHint) identities.set(keyHint, { id: keyHint, name: value });
		return;
	}
	if (!value || typeof value !== "object") return;

	const record = value as Record<string, unknown>;
	if (record.users && record.users !== value) {
		addSyncDirectoryValue(identities, record.users);
		return;
	}
	const id =
		normalizeId(record.id) ??
		normalizeId(record.uid) ??
		normalizeId(record.userId) ??
		(keyHint ?? null);
	const name =
		normalizeString(record.name) ??
		normalizeString(record.displayName) ??
		normalizeString(record.username) ??
		normalizeString(record.email);
	if (id && name) {
		identities.set(id, {
			id,
			name,
			...optionalString("picture", record.picture ?? record.avatar),
			...optionalString("color", record.color),
			...optionalString("colorLight", record.colorLight),
		});
		return;
	}

	for (const [key, entry] of Object.entries(record)) {
		addSyncDirectoryValue(identities, entry, key);
	}
}

function normalizeId(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		return String(value);
	}
	return normalizeString(value);
}

function normalizeString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized || null;
}

function optionalString<K extends string>(
	key: K,
	value: unknown,
): Partial<Record<K, string>> {
	const normalized = normalizeString(value);
	return normalized ? ({ [key]: normalized } as Record<K, string>) : {};
}

export function providerById(
	providers: IdentityProvider[],
	id: IdentityProviderId,
): IdentityProvider | null {
	return providers.find((provider) => provider.id === id) ?? null;
}

export function selectIdentityProvider(
	providers: IdentityProvider[],
	selected: IdentityProviderSetting,
): IdentityProvider | null {
	const available = providers.filter((provider) => provider.isAvailable());
	if (selected) {
		const preferred = providerById(available, selected);
		if (preferred) return preferred;
	}
	return available[0] ?? null;
}

function getRelayPlugin(app: App): RelayPluginLike | null {
	return (
		((app as AppWithPlugins).plugins?.plugins?.[
			"system3-relay"
		] as RelayPluginLike | undefined) ?? null
	);
}

function getRelayIdentityApi(value: unknown): RelayIdentityApiLike | null {
	if (!isRecord(value)) return null;
	const v0 = value.v0;
	if (!isRecord(v0) || !isRecord(v0.identity)) return null;
	const { users, currentUser } = v0.identity;
	if (
		!isRecord(users) ||
		typeof users.get !== "function" ||
		typeof users.subscribe !== "function" ||
		!isRecord(currentUser) ||
		!("value" in currentUser) ||
		typeof currentUser.subscribe !== "function"
	) {
		return null;
	}
	return v0.identity as unknown as RelayIdentityApiLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}
