import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "@jest/globals";
import {
	buildCommentDraftInsertion,
	commentDraftKey,
	mapCommentDraftAnchor,
	type CommentDraftAnchor,
} from "src/editor/comment-draft-anchor";

const anchor: CommentDraftAnchor = {
	id: 7,
	filePath: "note.md",
	from: 10,
	to: 20,
};

const doc = Text.of(["x".repeat(30)]);

describe("pending comment anchors", () => {
	it("moves with text inserted before the selected range", () => {
		const changes = ChangeSet.of({ from: 2, insert: "hello" }, 30);

		expect(mapCommentDraftAnchor(anchor, changes, doc)).toMatchObject({
			from: 15,
			to: 25,
		});
	});

	it("invalidates text inserted inside the selected range", () => {
		const changes = ChangeSet.of({ from: 15, insert: "new" }, 30);

		expect(mapCommentDraftAnchor(anchor, changes, doc)).toMatchObject({
			from: 10,
			to: 23,
			invalidated: true,
		});
	});

	it("invalidates a replacement of the entire selected range", () => {
		const changes = ChangeSet.of(
			{ from: 10, to: 20, insert: "replacement" },
			30,
		);

		expect(mapCommentDraftAnchor(anchor, changes, doc)).toMatchObject({
			from: 10,
			to: 21,
			invalidated: true,
		});
	});

	it("invalidates the anchor when the selection is deleted", () => {
		const changes = ChangeSet.of({ from: 10, to: 20 }, 30);

		expect(mapCommentDraftAnchor(anchor, changes, doc)).toMatchObject({
			from: 10,
			to: 10,
			invalidated: true,
		});
	});

	it("keeps the draft identity stable when its offsets move", () => {
		const shifted = mapCommentDraftAnchor(
			anchor,
			ChangeSet.of({ from: 2, insert: "hello" }, 30),
			doc,
		);

		expect(commentDraftKey(shifted)).toBe(commentDraftKey(anchor));
	});

	it("comments at the surviving point when the selected text is deleted", () => {
		expect(buildCommentDraftInsertion("", "{>>still relevant<<}")).toBe(
			"{>>still relevant<<}",
		);
	});

	it("wraps the current mapped text when it still exists", () => {
		expect(buildCommentDraftInsertion("rewritten", "{>>note<<}")).toBe(
			"{==rewritten==}{>>note<<}",
		);
	});
});

describe("pending comment anchors on a rewritten line", () => {
	const line = "- Selected target and {==other==}{>>question<<}";
	const before = Text.of([line, ""]);
	const reply = "{>>reply\nsecond line<<}";
	const passage = { id: 1, filePath: "note.md", from: 2, to: 17 };

	function rewrite(replacement: string): ChangeSet {
		return ChangeSet.of(
			{ from: 0, to: line.length, insert: replacement },
			before.length,
		);
	}

	it("keeps an untouched passage when a reply lands after it", () => {
		const changes = rewrite(line + reply);

		expect(mapCommentDraftAnchor(passage, changes, before)).toMatchObject({
			from: 2,
			to: 17,
		});
	});

	it("shifts an untouched passage past a reply that lands before it", () => {
		const leading = "{==other==}{>>question<<} and target";
		const doc = Text.of([leading, ""]);
		const target = { id: 1, filePath: "note.md", from: 30, to: 36 };
		const changes = ChangeSet.of(
			{
				from: 0,
				to: leading.length,
				insert: leading.replace("<<}", "<<}" + reply),
			},
			doc.length,
		);

		expect(mapCommentDraftAnchor(target, changes, doc)).toMatchObject({
			from: 30 + reply.length,
			to: 36 + reply.length,
		});
	});

	it("invalidates an edit to the passage itself", () => {
		const changes = rewrite(line.replace("target", "TARGET"));

		expect(mapCommentDraftAnchor(passage, changes, before)).toMatchObject({
			from: 2,
			to: 17,
			invalidated: true,
		});
	});

	it("invalidates when the rewrite removes the passage", () => {
		const changes = rewrite(line.replace("Selected target ", ""));

		expect(mapCommentDraftAnchor(passage, changes, before)).toMatchObject({
			from: 2,
			to: 2,
			invalidated: true,
		});
	});
});
