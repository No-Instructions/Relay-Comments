import type { App } from "obsidian";
import type {
	Identity,
	IdentityProvider,
	IdentityProviderId,
	IdentityProviderSetting,
	IdentityResolver,
} from "./types";

interface RelayIdentityApiLike {
	getCurrentUser(path: string): IdentityLike | null | Promise<IdentityLike | null>;
	resolveUser(
		id: string,
		path: string,
	): IdentityLike | null | Promise<IdentityLike | null>;
	getAuthorForRange?(
		path: string,
		from: number,
		to: number,
	): IdentityLike | null | Promise<IdentityLike | null>;
}

interface RelayPluginLike {
	api?: {
		version?: unknown;
		identity?: RelayIdentityApiLike;
	};
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

export function getRelayIdentitySupportStatus(
	app: App,
): RelayIdentitySupportStatus {
	const plugin = getRelayPlugin(app);
	if (!plugin) return "not-installed";
	return plugin.api?.version === 1 && plugin.api.identity
		? "available"
		: "unsupported";
}

export class RelayIdentityProvider implements IdentityProvider {
	readonly id = "relay";
	readonly name = "Relay";

	constructor(private readonly app: App) {}

	isAvailable(): boolean {
		return Boolean(this.getApi());
	}

	async getCurrentUser(path: string): Promise<Identity | null> {
		const api = this.getApi();
		if (!api) return null;
		return normalizeIdentity(await api.getCurrentUser(path));
	}

	async resolveUser(id: string, path: string): Promise<Identity | null> {
		const api = this.getApi();
		if (!api) return null;
		return normalizeIdentity(await api.resolveUser(id, path));
	}

	async getAuthorForRange(
		path: string,
		from: number,
		to: number,
	): Promise<Identity | null> {
		const api = this.getApi();
		if (!api?.getAuthorForRange) return null;
		return normalizeIdentity(await api.getAuthorForRange(path, from, to));
	}

	private getApi(): RelayIdentityApiLike | null {
		const plugin = getRelayPlugin(this.app);
		return plugin?.api?.version === 1 ? (plugin.api.identity ?? null) : null;
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
