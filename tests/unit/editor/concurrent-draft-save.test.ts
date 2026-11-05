import { ChangeSet, EditorState } from "@codemirror/state";
import { mapCommentDraftAnchor } from "src/editor/comment-draft-anchor";

test("a multiline reply elsewhere on the same source line leaves the draft saveable", () => {
	const before = "- Selected target and {==other==}{>>question<<}";
	const after = before + "{>>reply\nsecond line<<}";
	const state = EditorState.create({ doc: before });
	const changes = ChangeSet.of({ from: 0, to: before.length, insert: after }, before.length);
	const anchor = mapCommentDraftAnchor({ id: 1, filePath: "note.md", from: 2, to: 17 }, changes, state.doc);
	expect(anchor).toMatchObject({ from: 2, to: 17, invalidated: false });
	expect(changes.apply(state.doc).sliceString(anchor.from, anchor.to)).toBe("Selected target");
});

function update(before: string, after: string, from: number, to: number) {
	return mapCommentDraftAnchor(
		{ id: 1, filePath: "note.md", from, to },
		ChangeSet.of({ from: 0, to: before.length, insert: after }, before.length),
		EditorState.create({ doc: before }).doc,
	);
}

test.each(["- ", "1. ", "2) ", "- [ ] ", "# ", "> ", "> - [x] ", "\t- "])("preserves %s target across external updates before and after it", prefix => {
	const before = "{==other==}{>>question<<}\n" + prefix + "target\n";
	const from = before.indexOf("target");
	const reply = "{>>first line\nsecond line<<}";
	for (const after of [before.replace("{>>question<<}", "{>>question<<}" + reply), before + reply]) {
		const anchor = update(before, after, from, from + 6);
		expect(anchor.invalidated).toBe(false);
		expect(after.slice(anchor.from, anchor.to)).toBe("target");
	}
});

test("keeps the selected occurrence of repeated text after an unrelated reply", () => {
	const before = "target\n- target and {==other==}{>>question<<}";
	const from = before.lastIndexOf("target");
	const after = before + "{>>reply\nmore<<}";
	expect(update(before, after, from, from + 6)).toMatchObject({ from, to: from + 6, invalidated: false });
});

test.each(["changed", "", "tarXget", "target target"])("refuses a changed target: %j", replacement => {
	const before = "before target after";
	const after = before.replace("target", replacement);
	expect(update(before, after, 7, 13).invalidated).toBe(true);
});

test("does not choose between identical occurrences when a replacement deletes one", () => {
	for (const from of [0, 7]) {
		expect(update("target target", "target", from, from + 6).invalidated).toBe(true);
	}
});

test("handles successive incoming changes on either side", () => {
	let state = EditorState.create({ doc: "before\n- target\nafter" });
	let anchor = { id: 1, filePath: "note.md", from: 9, to: 15 };
	for (const next of ["before reply\n- target\nafter", "before reply\n- target\nafter reply", "before reply again\n- target\nafter reply"]) {
		const tr = state.update({ changes: { from: 0, to: state.doc.length, insert: next } });
		anchor = mapCommentDraftAnchor(anchor, tr.changes, state.doc);
		state = tr.state;
		expect(anchor).toMatchObject({ invalidated: false });
		expect(state.sliceDoc(anchor.from, anchor.to)).toBe("target");
	}
});

test("maps simultaneous granular edits on both sides without using selected text search", () => {
	const state = EditorState.create({ doc: "before\n- target\nafter" });
	const changes = ChangeSet.of([{ from: 0, insert: "A" }, { from: state.doc.length, insert: "B" }], state.doc.length);
	const anchor = mapCommentDraftAnchor({ id: 1, filePath: "note.md", from: 9, to: 15 }, changes, state.doc);
	expect(anchor).toMatchObject({ from: 10, to: 16, invalidated: false });
});

test("refuses a coarse replacement spanning both sides when continuity is unknown", () => {
	expect(update("before target after", "changed target edited", 7, 13).invalidated).toBe(true);
});

test("invalidation stays set after later unrelated edits", () => {
	let state = EditorState.create({ doc: "target after" });
	const first = state.update({ changes: { from: 1, to: 2, insert: "X" } });
	const anchor = mapCommentDraftAnchor({ id: 1, filePath: "note.md", from: 0, to: 6 }, first.changes, state.doc);
	state = first.state;
	const changes = ChangeSet.of({ from: state.doc.length, insert: " reply" }, state.doc.length);
	expect(mapCommentDraftAnchor(anchor, changes, state.doc).invalidated).toBe(true);
});

test.each([0, 6])("excludes a boundary insertion at %i from the target", position => {
	const state = EditorState.create({ doc: "target" });
	const changes = ChangeSet.of({ from: position, insert: "new " }, state.doc.length);
	const anchor = mapCommentDraftAnchor({ id: 1, filePath: "note.md", from: 0, to: 6 }, changes, state.doc);
	expect(anchor.invalidated).toBe(false);
	expect(changes.apply(state.doc).sliceString(anchor.from, anchor.to)).toBe("target");
});
