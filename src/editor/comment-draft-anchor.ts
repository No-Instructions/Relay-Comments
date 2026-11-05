import {
	ChangeSet,
	type ChangeDesc,
	type ChangeSpec,
	type Text,
} from "@codemirror/state";

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
 *
 * Obsidian loads an external edit into an open note by replacing whole
 * lines, so every replacement is first narrowed to the text that actually
 * differs; a passage the rewrite left untouched keeps its exact range.
 */
export function mapCommentDraftAnchor(
	anchor: CommentDraftAnchor,
	changes: ChangeSet,
	before: Text,
): CommentDraftAnchor {
	const narrowed = narrowToDifferingText(changes, before);
	return {
		...anchor,
		from: narrowed.mapPos(anchor.from, -1),
		to: narrowed.mapPos(anchor.to, 1),
	};
}

/** Drop the unchanged head and tail of each replacement before mapping through it. */
function narrowToDifferingText(changes: ChangeSet, before: Text): ChangeDesc {
	const specs: ChangeSpec[] = [];
	changes.iterChanges((from, to, _fromB, _toB, inserted) => {
		const removed = before.sliceString(from, to);
		const added = inserted.toString();
		const limit = Math.min(removed.length, added.length);
		let head = 0;
		while (head < limit && removed.charCodeAt(head) === added.charCodeAt(head)) {
			head += 1;
		}
		let tail = 0;
		while (
			tail < limit - head &&
			removed.charCodeAt(removed.length - 1 - tail) ===
				added.charCodeAt(added.length - 1 - tail)
		) {
			tail += 1;
		}
		specs.push({
			from: from + head,
			to: to - tail,
			insert: added.slice(head, added.length - tail),
		});
	});
	return ChangeSet.of(specs, before.length).desc;
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
