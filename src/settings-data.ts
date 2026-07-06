export interface RelayCommentsSettings {
	/** The add-comment button in the editor margin on selection. */
	showInlineActions: boolean;
	openSidebarOnCommentSelect: boolean;
	showHoverPreview: boolean;
}

export const DEFAULT_SETTINGS: RelayCommentsSettings = {
	showInlineActions: true,
	openSidebarOnCommentSelect: true,
	showHoverPreview: true,
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
	};
}
