import { Notice, type App, type Editor } from "obsidian";
import {
	findFirstMarkInRange,
	findMarkAtOffset,
	parseCriticMarkup,
} from "../critic/parse";
import { replacementForMark, type CriticAction } from "../critic/transform";
import type { CriticMark } from "../critic/types";
import { promptText } from "../ui/PromptModal";

export function wrapSelection(
	editor: Editor,
	type: "addition" | "deletion" | "highlight",
): void {
	const selection = editor.getSelection();
	const wrappers = {
		addition: ["{++", "++}"],
		deletion: ["{--", "--}"],
		highlight: ["{==", "==}"],
	} as const;
	const [open, close] = wrappers[type];
	const insertionStart = editor.posToOffset(editor.getCursor("from"));
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
	const text = editor.getValue();
	const marks = parseCriticMarkup(text);
	const from = editor.posToOffset(editor.getCursor("from"));
	const to = editor.posToOffset(editor.getCursor("to"));
	if (from !== to) {
		return findFirstMarkInRange(marks, from, to);
	}
	return findMarkAtOffset(marks, from);
}
