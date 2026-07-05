export interface RelayCommentsSettings {
	showAuthorChips: boolean;
	showInlineActions: boolean;
	openSidebarOnCommentSelect: boolean;
}

export const DEFAULT_SETTINGS: RelayCommentsSettings = {
	showAuthorChips: true,
	showInlineActions: true,
	openSidebarOnCommentSelect: true,
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
	return {
		showAuthorChips: data.showAuthorChips ?? DEFAULT_SETTINGS.showAuthorChips,
		showInlineActions:
			data.showInlineActions ?? DEFAULT_SETTINGS.showInlineActions,
		openSidebarOnCommentSelect:
			data.openSidebarOnCommentSelect ??
			data.enableReviewSidebar ??
			DEFAULT_SETTINGS.openSidebarOnCommentSelect,
	};
}
