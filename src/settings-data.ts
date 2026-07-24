import type {
	Identity,
	IdentityProviderSetting,
} from "./identity/types";

export interface RelayCommentsSettings {
	/** The add-comment button in the editor margin on selection. */
	showInlineActions: boolean;
	openSidebarOnCommentSelect: boolean;
	showHoverPreview: boolean;
	identityProvider: IdentityProviderSetting;
	identities: Identity[];
	authorName: string;
	authorPicture: string;
}

export const DEFAULT_SETTINGS: RelayCommentsSettings = {
	showInlineActions: true,
	openSidebarOnCommentSelect: true,
	showHoverPreview: true,
	identityProvider: null,
	identities: [],
	authorName: "",
	authorPicture: "",
};

/**
 * Build settings from whatever loadData() returned, from any prior plugin
 * version. Unknown shapes fall back to defaults, never throw.
 */
export function resolveSettings(loaded: unknown): RelayCommentsSettings {
	const data = (loaded ?? {}) as Partial<
		RelayCommentsSettings & {
			/** Pre-0.2 name for the auto-open behavior. */
			enableReviewSidebar: boolean;
		}
	>;
	// Dropped keys from older versions (showAuthorChips) are ignored here
	// and disappear on the next save.
	return {
		showInlineActions:
			data.showInlineActions ?? DEFAULT_SETTINGS.showInlineActions,
		openSidebarOnCommentSelect:
			data.openSidebarOnCommentSelect ??
			data.enableReviewSidebar ??
			DEFAULT_SETTINGS.openSidebarOnCommentSelect,
		showHoverPreview:
			data.showHoverPreview ?? DEFAULT_SETTINGS.showHoverPreview,
		identityProvider: resolveIdentityProvider(data.identityProvider),
		identities: resolveIdentities(data.identities),
		authorName: optionalString(data.authorName) ?? "",
		authorPicture: optionalString(data.authorPicture) ?? "",
	};
}

function resolveIdentityProvider(value: unknown): IdentityProviderSetting {
	return value === "relay" || value === "obsidian-sync" ? value : null;
}

function resolveIdentities(value: unknown): Identity[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const identities: Identity[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const id = optionalString(record.id);
		const name = optionalString(record.name);
		if (!id || !name || seen.has(id)) continue;
		seen.add(id);
		identities.push({
			id,
			name,
			...optionalProperty("picture", record.picture),
			...optionalProperty("color", record.color),
			...optionalProperty("colorLight", record.colorLight),
		});
	}
	return identities;
}

function optionalProperty<K extends string>(
	key: K,
	value: unknown,
): Partial<Record<K, string>> {
	const normalized = optionalString(value);
	return normalized ? ({ [key]: normalized } as Record<K, string>) : {};
}

function optionalString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized || null;
}
