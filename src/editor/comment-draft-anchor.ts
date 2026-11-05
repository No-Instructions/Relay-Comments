import { ChangeSet, type ChangeSpec, type Text } from "@codemirror/state";

export interface CommentDraftAnchor {
	id: number;
	filePath: string;
	from: number;
	to: number;
	invalidated?: boolean;
}

/** Map only changed text: external file loads can replace unchanged line content. */
export function mapCommentDraftAnchor(
	anchor: CommentDraftAnchor,
	changes: ChangeSet,
	before: Text,
): CommentDraftAnchor {
	const edits: ChangeSpec[] = [];
	let invalidated = anchor.invalidated ?? false;
	changes.iterChanges((from, to, _fromB, _toB, inserted) => {
		const oldText = before.sliceString(from, to);
		const newText = inserted.toString();
		if (oldText === newText) return;
		const limit = Math.min(oldText.length, newText.length);
		let prefix = 0;
		while (prefix < limit && oldText[prefix] === newText[prefix]) prefix++;
		let suffix = 0;
		while (suffix < limit && oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]) suffix++;

		// Overlapping equal edges admit multiple placements of an insertion/deletion.
		// Refuse a draft touched by any such placement instead of choosing an occurrence.
		const earliest = from + Math.min(prefix, limit - suffix);
		const latest = to - Math.min(suffix, limit - prefix);
		if (earliest < anchor.to && latest > anchor.from) invalidated = true;
		suffix = Math.min(suffix, limit - prefix);
		edits.push({ from: from + prefix, to: to - suffix, insert: newText.slice(prefix, newText.length - suffix) });
	});
	const mapped = ChangeSet.of(edits, before.length);
	const from = mapped.mapPos(anchor.from, 1);
	return {
		...anchor,
		from,
		to: Math.max(from, mapped.mapPos(anchor.to, -1)),
		invalidated,
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
