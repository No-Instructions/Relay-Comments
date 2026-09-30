import { Notice, type App, type Editor } from "obsidian";
import {
	findFirstMarkInRange,
	findMarkAtOffset,
	parseCriticMarkup,
} from "../critic/parse";
import { narrowAnchorRange, type AnchorRange } from "../critic/anchor-range";
import { replacementForMark, type CriticAction } from "../critic/transform";
import type { CriticMark } from "../critic/types";
import { promptText } from "../ui/PromptModal";

export function wrapSelection(
	editor: Editor,
	type: "addition" | "deletion" | "highlight",
): void {
	const wrappers = {
		addition: ["{++", "++}"],
		deletion: ["{--", "--}"],
		highlight: ["{==", "==}"],
	} as const;
	const [open, close] = wrappers[type];
	const insertionStart = editor.posToOffset(editor.getCursor("from"));
	if (type === "highlight") {
		// A highlight anchors text, so block syntax stays outside it. Every
		// selection is wrapped in one transaction, and each caret ends after
		// its closing marker.
		const text = editor.getValue();
		const anchors = editor
			.listSelections()
			.map((range) => {
				const a = editor.posToOffset(range.anchor);
				const b = editor.posToOffset(range.head);
				return narrowAnchorRange(text, Math.min(a, b), Math.max(a, b));
			})
			.filter((anchor): anchor is AnchorRange => anchor !== null)
			.sort((a, b) => a.from - b.from);
		if (anchors.length > 0) {
			const wrapped = anchors.reduce(
				(result, anchor, index) => {
					const previousEnd = index === 0 ? 0 : anchors[index - 1].to;
					return result + text.slice(previousEnd, anchor.from) + open + text.slice(anchor.from, anchor.to) + close;
				},
				"",
			) + text.slice(anchors[anchors.length - 1].to);
			const added = open.length + close.length;
			editor.transaction(
				{
					changes: anchors.map((anchor) => ({
						from: editor.offsetToPos(anchor.from),
						to: editor.offsetToPos(anchor.to),
						text: `${open}${text.slice(anchor.from, anchor.to)}${close}`,
					})),
					selections: anchors.map((anchor, index) => ({
						from: positionAt(wrapped, anchor.to + added * (index + 1)),
					})),
				},
				"relay-comments",
			);
			return;
		}
	}
	const selection = editor.getSelection();
	editor.replaceSelection(`${open}${selection}${close}`, "relay-comments");
	if (selection.length === 0) {
		editor.setCursor(editor.offsetToPos(insertionStart + open.length));
	}
}

export async function addSubstitution(app: App, editor: Editor): Promise<void> {
	const selection = editor.getSelection();
	const replacement = await promptText(app, "Replacement text", {
		value: selection,
		submitText: "Insert substitution",
	});
	if (replacement === null) return;
	editor.replaceSelection(`{~~${selection}~>${replacement}~~}`, "relay-comments");
}

export function applyCurrentMarkAction(
	editor: Editor,
	action: CriticAction,
): boolean {
	const mark = getCurrentMark(editor);
	if (!mark) {
		new Notice("No comment or suggestion at the cursor.");
		return false;
	}
	replaceMark(editor, mark, action);
	return true;
}

export function applyAllInEditor(editor: Editor, action: CriticAction): void {
	const marks = parseCriticMarkup(editor.getValue()).filter(
		(mark) => mark.valid,
	);
	if (marks.length === 0) {
		new Notice("No comments or suggestions in this note.");
		return;
	}
	// One transaction with per-mark changes keeps undo atomic and avoids the
	// whole-document rewrite that setValue would push through collaboration.
	editor.transaction(
		{
			changes: marks.map((mark) => ({
				from: editor.offsetToPos(mark.from),
				to: editor.offsetToPos(mark.to),
				text: replacementForMark(mark, action),
			})),
		},
		"relay-comments",
	);
}

export function replaceMark(
	editor: Editor,
	mark: CriticMark,
	action: CriticAction,
): void {
	editor.replaceRange(
		replacementForMark(mark, action),
		editor.offsetToPos(mark.from),
		editor.offsetToPos(mark.to),
		"relay-comments",
	);
}

export function getCurrentMark(editor: Editor): CriticMark | null {
	const marks = parseCriticMarkup(editor.getValue());
	return markForRange(
		marks,
		editor.posToOffset(editor.getCursor("from")),
		editor.posToOffset(editor.getCursor("to")),
	);
}

/** The mark a selection sits in: the first one a range touches, or the one at a caret. */
export function markForRange(
	marks: CriticMark[],
	from: number,
	to: number,
): CriticMark | null {
	if (from !== to) return findFirstMarkInRange(marks, from, to);
	return findMarkAtOffset(marks, from);
}

/** Line and column of an offset in `text`, for positions in a document that does not exist yet. */
function positionAt(text: string, offset: number): { line: number; ch: number } {
	const head = text.slice(0, offset);
	const line = (head.match(/\n/g) ?? []).length;
	return { line, ch: offset - (head.lastIndexOf("\n") + 1) };
}
