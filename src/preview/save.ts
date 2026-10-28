import type { Editor, MarkdownView } from "obsidian";
import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** Bring the hidden editor up to date before a Reading-mode action. External
 * changes are a document load, not an undoable user edit. Keep the unchanged
 * prefix/suffix so existing selections and history can map through the update.
 */
export function syncEditorFromReadingMode(
	view: Pick<MarkdownView, "getMode" | "previewMode">,
	cm: Pick<EditorView, "state" | "dispatch">,
): void {
	if (view.getMode() !== "preview") return;
	const before = cm.state.doc.toString();
	const after = view.previewMode.get();
	if (before === after) return;
	let from = 0;
	while (from < before.length && from < after.length && before[from] === after[from]) from += 1;
	let to = before.length;
	let end = after.length;
	while (to > from && end > from && before[to - 1] === after[end - 1]) {
		to -= 1;
		end -= 1;
	}
	cm.dispatch({
		changes: { from, to, insert: after.slice(from, end) },
		annotations: [Transaction.addToHistory.of(false), Transaction.userEvent.of("set")],
	});
}

/** Reading mode is Obsidian's save source while its editor is hidden.
 * Keep that source current after our normal editor transaction, without
 * replacing the editor or clearing its undo history.
 */
export function syncReadingModeAfterEdit(
	view: Pick<MarkdownView, "editor" | "getMode" | "previewMode" | "requestSave">,
	editor: Editor,
): void {
	if (view.editor !== editor || view.getMode() !== "preview") return;
	const text = editor.getValue();
	if (view.previewMode.get() === text) return;
	view.previewMode.set(text, false);
	view.requestSave();
}
