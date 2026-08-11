import type { App, EventRef } from "obsidian";
import type {
	Identity,
	IdentityProvider,
	IdentityProviderId,
	IdentityProviderSetting,
	IdentityResolver,
} from "./types";
import type { ApiV0, RelayEvent, User } from "./relay-plugin-api";

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
const RELAY_USERS_EVENT = "system3-relay:v0:users";
const RELAY_CURRENT_USER_EVENT = "system3-relay:v0:current-user";

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
	private users = new Map<string, Identity>();
	private currentUser: Identity | null = null;
	private subscriptions = 0;

	constructor(private readonly app: App) {}

	isAvailable(): boolean {
		this.prepareRead();
		return this.currentUser !== null;
	}

	async getCurrentUser(_path: string): Promise<Identity | null> {
		this.prepareRead();
		return this.currentUser ? { ...this.currentUser } : null;
	}

	async resolveUser(id: string, _path: string): Promise<Identity | null> {
		this.prepareRead();
		const identity = this.users.get(id);
		return identity ? { ...identity } : null;
	}

	subscribe(onChange: () => void): () => void {
		this.subscriptions += 1;
		const refresh = (): void => {
			this.resnapshot();
			onChange();
		};
		const applyUsers = (event: RelayEvent<User>): void => {
			const id = normalizeId(event.record.id);
			if (id === null) return;
			if (event.action === "delete") {
				this.users.delete(id);
			} else {
				const identity = normalizeIdentity(event.record);
				if (!identity) return;
				this.users.set(identity.id, identity);
			}
			onChange();
		};
		const applyCurrentUser = (event: RelayEvent<User | null>): void => {
			this.currentUser = normalizeIdentity(event.record);
			onChange();
		};

		const eventRefs: EventRef[] = [
			this.app.workspace.on(RELAY_API_READY_EVENT, refresh),
			this.app.workspace.on(RELAY_USERS_EVENT, applyUsers),
			this.app.workspace.on(RELAY_CURRENT_USER_EVENT, applyCurrentUser),
		];
		if (this.resnapshot()) onChange();

		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			this.subscriptions = Math.max(0, this.subscriptions - 1);
			for (const eventRef of eventRefs) {
				this.app.workspace.offref(eventRef);
			}
		};
	}

	private getApi(): ApiV0 | null {
		return getRelayIdentityApi(getRelayPlugin(this.app)?.api);
	}

	private prepareRead(): void {
		if (!this.getApi()) {
			this.clearSnapshot();
			return;
		}
		if (this.subscriptions === 0) this.resnapshot();
	}

	private resnapshot(): boolean {
		const api = this.getApi();
		if (!api) {
			this.clearSnapshot();
			return false;
		}
		try {
			const users = new Map<string, Identity>();
			for (const record of api.getUsers()) {
				const identity = normalizeIdentity(record);
				if (identity) users.set(identity.id, identity);
			}
			this.users = users;
			this.currentUser = normalizeIdentity(api.getCurrentUser());
			return true;
		} catch {
			// A retained v0 facade throws after Relay unloads. Treat that the same
			// as an unavailable provider until the next payload-free ready event.
			this.clearSnapshot();
			return false;
		}
	}

	private clearSnapshot(): void {
		this.users.clear();
		this.currentUser = null;
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
			const instance = this.getPlugin()?.instance;
			if (!instance?.getUsernames) return new Map<string, Identity>();
			try {
				return normalizeSyncDirectory(await instance.getUsernames());
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

function getRelayIdentityApi(value: unknown): ApiV0 | null {
	if (!isRecord(value)) return null;
	const v0 = value.v0;
	if (
		!isRecord(v0) ||
		typeof v0.getUsers !== "function" ||
		typeof v0.getCurrentUser !== "function"
	) {
		return null;
	}
	return v0 as unknown as ApiV0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}
