import { ChangeSet } from "@codemirror/state";
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

describe("pending comment anchors", () => {
	it("moves with text inserted before the selected range", () => {
		const changes = ChangeSet.of({ from: 2, insert: "hello" }, 30);

		expect(mapCommentDraftAnchor(anchor, changes)).toMatchObject({
			from: 15,
			to: 25,
		});
	});

	it("includes text inserted inside the selected range", () => {
		const changes = ChangeSet.of({ from: 15, insert: "new" }, 30);

		expect(mapCommentDraftAnchor(anchor, changes)).toMatchObject({
			from: 10,
			to: 23,
		});
	});

	it("follows a replacement of the entire selected range", () => {
		const changes = ChangeSet.of(
			{ from: 10, to: 20, insert: "replacement" },
			30,
		);

		expect(mapCommentDraftAnchor(anchor, changes)).toMatchObject({
			from: 10,
			to: 21,
		});
	});

	it("collapses to the surviving point when the selection is deleted", () => {
		const changes = ChangeSet.of({ from: 10, to: 20 }, 30);

		expect(mapCommentDraftAnchor(anchor, changes)).toMatchObject({
			from: 10,
			to: 10,
		});
	});

	it("keeps the draft identity stable when its offsets move", () => {
		const shifted = mapCommentDraftAnchor(
			anchor,
			ChangeSet.of({ from: 2, insert: "hello" }, 30),
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
