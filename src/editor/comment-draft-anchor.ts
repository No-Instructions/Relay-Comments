import type { ChangeDesc } from "@codemirror/state";

export interface CommentDraftAnchor {
	id: number;
	filePath: string;
	from: number;
	to: number;
}

/**
 * Follow a pending comment range through a CodeMirror document change.
 * Inclusive boundary association keeps replacement text anchored when a
 * collaborator rewrites the entire selected range. A complete deletion
 * intentionally collapses the range to the surviving insertion point.
 */
export function mapCommentDraftAnchor(
	anchor: CommentDraftAnchor,
	changes: ChangeDesc,
): CommentDraftAnchor {
	return {
		...anchor,
		from: changes.mapPos(anchor.from, -1),
		to: changes.mapPos(anchor.to, 1),
	};
}

export function commentDraftKey(draft: { id: number }): string {
	return String(draft.id);
}

export function buildCommentDraftInsertion(
	selectedText: string,
	commentMarkup: string,
): string {
	return selectedText.length > 0
		? `{==${selectedText}==}${commentMarkup}`
		: commentMarkup;
}
