export interface Identity {
	id: string;
	name: string;
	picture?: string;
	color?: string;
	colorLight?: string;
}

export type IdentityProviderId = "relay" | "obsidian-sync";

export type IdentityResolverId = IdentityProviderId | "configured";

export type IdentityProviderSetting = IdentityProviderId | null;

export interface IdentityResolver {
	readonly id: IdentityResolverId;
	readonly name: string;

	isAvailable(): boolean;
	resolveUser(id: string, path: string): Promise<Identity | null>;
	/** Return a cached identity synchronously when the provider maintains one. */
	resolveUserSnapshot?(id: string, path: string): Identity | null;
}

export interface IdentityProvider extends IdentityResolver {
	readonly id: IdentityProviderId;

	getCurrentUser(path: string): Promise<Identity | null>;
	/** Return the cached current identity synchronously when available. */
	getCurrentUserSnapshot?(path: string): Identity | null;

	/**
	 * Notify the consumer when availability or identity data changes.
	 * Providers without a live API may omit this.
	 */
	subscribe?(onChange: () => void): () => void;

	/** Optional enhancement for providers with document provenance. */
	getAuthorForRange?(
		path: string,
		from: number,
		to: number,
	): Promise<Identity | null>;
}

export interface IdentityProviderOption {
	id: IdentityProviderId;
	name: string;
}
