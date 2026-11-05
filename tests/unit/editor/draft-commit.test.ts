import { EditorState, StateEffect, type StateField } from "@codemirror/state";
import RelayCommentsPlugin from "src/main";
import { Notice, editorInfoField } from "obsidian";
import { createReviewEditorExtension, setCommentDraftAnchor, type ReviewEditorController } from "src/editor/extension";
import { mapCommentDraftAnchor, type CommentDraftAnchor } from "src/editor/comment-draft-anchor";

jest.mock("obsidian", () => {
	const { StateField } = jest.requireActual<typeof import("@codemirror/state")>("@codemirror/state");
	return {
		Plugin: class {}, Component: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {},
		Notice: jest.fn(), Platform: {}, requireApiVersion: () => false,
		editorInfoField: StateField.define({ create: () => ({ file: { path: "note.md" } }), update: (value, tr) => tr.effects.find(effect => effect.value?.file)?.value ?? value }),
		editorLivePreviewField: StateField.define({ create: () => true, update: value => value }),
	};
}, { virtual: true });

function fixture(text = "- target and {==other==}{>>question<<}", nativeHighlight = false) {
	const editorView = { state: EditorState.create({ doc: text }), dom: { isConnected: false } };
	const editor = {
		getValue: () => editorView.state.doc.toString(),
		offsetToPos: (offset: number) => {
			const line = editorView.state.doc.lineAt(offset);
			return { line: line.number - 1, ch: offset - line.from };
		},
		replaceRange: jest.fn((insert: string, from: { line: number; ch: number }, to = from) => {
			const doc = editorView.state.doc;
			editorView.state = editorView.state.update({ changes: { from: doc.line(from.line + 1).from + from.ch, to: doc.line(to.line + 1).from + to.ch, insert } }).state;
		}),
	};
	const surface = { file: { path: "note.md" }, editor, editorView };
	const from = text.indexOf("target");
	const draft = { id: 1, filePath: "note.md", from, to: from + 6, selectedText: "target", nativeHighlight, invalidated: false, document: editorView.state.doc };
	const plugin = Object.assign(Object.create(RelayCommentsPlugin.prototype), {
		commentDraft: draft, commentDraftEditorView: editorView,
		syncReadingModeBeforeEdit: jest.fn(), syncReadingModeAfterEdit: jest.fn(),
		findReviewEditorSurface: () => surface,
		getCurrentReviewerIdentityAsync: async () => ({ name: "Reviewer", source: "local" }),
		refuseIfReadOnly: () => false,
		formatAttachedCommentMarkup: (body: string) => `{>>${body}<<}`,
		refreshReviewSidebars: jest.fn(), scheduleReviewSidebarRefresh: jest.fn(),
	});
	return {
		plugin, draft, editor, editorView, surface,
		externalUpdate(after: string) {
			const tr = editorView.state.update({ changes: { from: 0, to: editorView.state.doc.length, insert: after } });
			const anchor = mapCommentDraftAnchor(draft, tr.changes, editorView.state.doc);
			editorView.state = tr.state;
			plugin.updateCommentDraftAnchor(anchor.id, anchor.filePath, anchor.from, anchor.to, tr.state.sliceDoc(anchor.from, anchor.to), tr.state.doc, anchor.invalidated ?? false);
		},
	};
}

test.each(["before", "after"])("saves the body after an unrelated multiline reply %s the anchor", async position => {
	const text = position === "before" ? "{==other==}{>>question<<} and target" : "- target and {==other==}{>>question<<}";
	const f = fixture(text);
	const after = text.replace("{>>question<<}", "{>>question<<}{>>reply\nsecond line<<}");
	f.externalUpdate(after);
	await f.plugin.commitCommentDraft("My draft body");
	expect(f.editor.getValue()).toBe(after.replace("target", "{==target==}{>>My draft body<<}"));
	expect(f.plugin.commentDraft).toBeNull();
});

test.each(["changed", "", "tarXget"])("retains the draft after target replacement with %j", async replacement => {
	const f = fixture();
	f.externalUpdate(f.editor.getValue().replace("target", replacement));
	await f.plugin.commitCommentDraft("My unsaved body");
	expect(f.plugin.commentDraft).toBe(f.draft);
	expect(f.draft.selectedText).toBe("target");
	expect(f.editor.replaceRange).not.toHaveBeenCalled();
	expect(Notice).toHaveBeenCalledWith(expect.stringContaining("Your draft has been kept"));
});

test.each(["- target", "# target", "> target", "1. target", "- [ ] target"])("retains block prefixes when saving %s", async text => {
	const f = fixture(text);
	await f.plugin.commitCommentDraft("body");
	expect(f.editor.getValue()).toBe(text.replace("target", "{==target==}{>>body<<}"));
});

test("uses the updated range when a reply arrives during identity lookup", async () => {
	const f = fixture();
	f.plugin.getCurrentReviewerIdentityAsync = async () => {
		f.externalUpdate("new line\n" + f.editor.getValue());
		return { name: "Reviewer", source: "local" };
	};
	await f.plugin.commitCommentDraft("body");
	expect(f.editor.getValue()).toBe("new line\n- {==target==}{>>body<<} and {==other==}{>>question<<}");
});

test("rejects a target edit arriving during identity lookup", async () => {
	const f = fixture();
	f.plugin.getCurrentReviewerIdentityAsync = async () => {
		f.externalUpdate(f.editor.getValue().replace("target", "changed"));
		return { name: "Reviewer", source: "local" };
	};
	await f.plugin.commitCommentDraft("body");
	expect(f.editor.replaceRange).not.toHaveBeenCalled();
	expect(f.plugin.commentDraft).toBe(f.draft);
});

test.each(["document", "view", "note"])("rejects a replaced %s without using stale offsets", async kind => {
	const f = fixture();
	if (kind === "document") f.editorView.state = EditorState.create({ doc: f.editor.getValue() });
	if (kind === "view") f.surface.editorView = { ...f.editorView };
	if (kind === "note") f.surface.file.path = "other.md";
	await f.plugin.commitCommentDraft("body");
	expect(f.editor.replaceRange).not.toHaveBeenCalled();
	expect(f.plugin.commentDraft).toBe(f.draft);
});

test.each(["{==target==}", "==target=="])("rejects new invalid structure around target: %s", async text => {
	const f = fixture("target");
	f.externalUpdate(text);
	await f.plugin.commitCommentDraft("body");
	expect(f.editor.replaceRange).not.toHaveBeenCalled();
	expect(f.plugin.commentDraft).toBe(f.draft);
});

test("preserves a native highlight after an unrelated reply", async () => {
	const f = fixture("==target== and {==other==}{>>question<<}", true);
	f.externalUpdate(f.editor.getValue() + "{>>reply\nmore<<}");
	await f.plugin.commitCommentDraft("body");
	expect(f.editor.getValue()).toBe("==target=={>>body<<} and {==other==}{>>question<<}{>>reply\nmore<<}");
});

test("does not convert a removed native highlight into a new anchor", async () => {
	const f = fixture("==target==", true);
	f.externalUpdate("target");
	await f.plugin.commitCommentDraft("body");
	expect(f.editor.replaceRange).not.toHaveBeenCalled();
	expect(f.plugin.commentDraft).toBe(f.draft);
});


test("the editor state field maps external changes and invalidates a switch away and back", () => {
	const extensions = createReviewEditorExtension({ getDisplayMode: () => "review" } as ReviewEditorController).extension as unknown[];
	const field = extensions[1] as StateField<CommentDraftAnchor | null>;
	const before = "- target and {==other==}{>>question<<}";
	let state = EditorState.create({ doc: before, extensions: [field, editorInfoField] });
	state = state.update({ effects: setCommentDraftAnchor.of({ id: 1, filePath: "note.md", from: 2, to: 8 }) }).state;
	state = state.update({ changes: { from: 0, to: before.length, insert: before + "{>>reply\nmore<<}" } }).state;
	expect(state.field(field)).toMatchObject({ from: 2, to: 8, invalidated: false });
	const setFile = StateEffect.define<{ file: { path: string } }>();
	state = state.update({ effects: setFile.of({ file: { path: "other.md" } }) }).state;
	state = state.update({ effects: setFile.of({ file: { path: "note.md" } }) }).state;
	expect(state.field(field)?.invalidated).toBe(true);
});


test("checks the tracked draft after synchronizing reading-mode content", async () => {
	const f = fixture();
	f.plugin.syncReadingModeBeforeEdit = () => {
		f.externalUpdate(f.editor.getValue().replace("target", "changed"));
	};
	await f.plugin.commitCommentDraft("body");
	expect(f.editor.replaceRange).not.toHaveBeenCalled();
	expect(f.plugin.commentDraft).toBe(f.draft);
});
