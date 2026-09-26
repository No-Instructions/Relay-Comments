import { describe, expect, it } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isEditorReadOnly } from "src/editor/access";

describe("isEditorReadOnly", () => {
	it("is false for an ordinary editor state", () => {
		expect(isEditorReadOnly({ state: EditorState.create({ doc: "text" }) })).toBe(false);
	});

	it("honours the readOnly facet", () => {
		const state = EditorState.create({
			doc: "text",
			extensions: [EditorState.readOnly.of(true)],
		});
		expect(isEditorReadOnly({ state })).toBe(true);
	});

	it("honours a non-editable view", () => {
		// Relay sets both facets for a note in a read-only folder.
		const state = EditorState.create({
			doc: "text",
			extensions: [EditorView.editable.of(false)],
		});
		expect(isEditorReadOnly({ state })).toBe(true);
	});
});
