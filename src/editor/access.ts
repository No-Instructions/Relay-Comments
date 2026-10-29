import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export const READ_ONLY_NOTICE = "This note is read-only.";

/** Whether the editor refuses edits, as Relay marks notes in a read-only folder. */
export function isEditorReadOnly(view: { state: EditorState }): boolean {
	return view.state.readOnly || !view.state.facet(EditorView.editable);
}

export function editorAccessChanged(before: EditorState, after: EditorState): boolean {
	return isEditorReadOnly({ state: before }) !== isEditorReadOnly({ state: after });
}
