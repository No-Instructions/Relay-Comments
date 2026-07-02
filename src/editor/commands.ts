import { Notice, type App, type Editor } from "obsidian";
import {
	findFirstMarkInRange,
	findMarkAtOffset,
	parseCriticMarkup,
} from "../critic/parse";
import {
	applyAllMarkActions,
	replacementForMark,
	type CriticAction,
} from "../critic/transform";
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
	editor.replaceSelection(`${open}${selection}${close}`, "criticmarkup");
}

export async function addSubstitution(app: App, editor: Editor): Promise<void> {
	const selection = editor.getSelection();
	const replacement = await promptText(app, "Replacement text", {
		value: selection,
		submitText: "Insert substitution",
	});
	if (replacement === null) return;
	editor.replaceSelection(`{~~${selection}~>${replacement}~~}`, "criticmarkup");
}

export function applyCurrentMarkAction(
	editor: Editor,
	action: CriticAction,
): boolean {
	const mark = getCurrentMark(editor);
	if (!mark) {
		new Notice("No CriticMarkup mark at the cursor.");
		return false;
	}
	replaceMark(editor, mark, action);
	return true;
}

export function applyAllInEditor(editor: Editor, action: CriticAction): void {
	const text = editor.getValue();
	const next = applyAllMarkActions(text, action);
	if (next === text) {
		new Notice("No CriticMarkup marks to update.");
		return;
	}
	editor.setValue(next);
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
		"criticmarkup",
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
