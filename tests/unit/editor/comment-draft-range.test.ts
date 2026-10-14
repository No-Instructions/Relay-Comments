import { ChangeSet, EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "@jest/globals";
import { parseCriticMarkup } from "src/critic/parse";
import { narrowAnchorRange } from "src/critic/anchor-range";
import { buildCommentDraftInsertion, mapCommentDraftAnchor } from "src/editor/comment-draft-anchor";
import { commentDraftContentRange } from "src/editor/comment-draft-range";
import { findNativeHighlightForSelection, parseNativeHighlights } from "src/markdown/highlights";

const comment = '{{authorId="reviewer" author="Reviewer">>test<<}}';

function insertComment(documentText: string, from: number, to: number): string {
	const range = commentDraftContentRange(documentText, from, to);
	if (!range) throw new Error("Unsupported comment range");
	return documentText.slice(0, range.from)
		+ buildCommentDraftInsertion(documentText.slice(range.from, range.to), comment)
		+ documentText.slice(range.to);
}

describe("block comment content ranges", () => {
	it.each([
		"1. ", "12) ", "- ", "* ", "+ ",
		"- [ ] ", "- [x] ", "- [X] ", "2. [ ] ",
		"# ", "## ", "###### ", "> ", ">> ", "> > ",
		"  - ", "    - ", "\t- ", "> - [ ] ", "- > ", "> ## ", "1.\t",
	])("preserves the %j prefix and following block", (prefix) => {
		const before = "Earlier text.\n";
		const line = prefix + "**Selected text.**";
		const after = "\n3. Following item.\n\nPlain paragraph.";
		const text = before + line + after;
		for (const trailingNewline of [0, 1]) {
			const result = insertComment(text, before.length, before.length + line.length + trailingNewline);
			expect(result).toBe(before + prefix + "{==**Selected text.**==}" + comment + after);
			const marks = parseCriticMarkup(result);
			expect(marks.map((mark) => mark.type)).toEqual(["highlight", "comment"]);
			expect(marks.every((mark) => mark.valid)).toBe(true);
			expect(marks[0].raw).toBe("{==**Selected text.**==}");
			expect(marks[1].raw).toBe(comment);
		}
	});

	it("keeps a heading's closing hashes and line break outside the comment", () => {
		const text = "## Heading ##\nNext paragraph";
		expect(insertComment(text, 0, text.indexOf("\n") + 1)).toBe(
			"## {==Heading==}" + comment + " ##\nNext paragraph",
		);
	});

	it("preserves CRLF after a whole heading selection", () => {
		const text = "# Heading\r\nNext paragraph";
		expect(insertComment(text, 0, text.indexOf("\n") + 1)).toBe(
			"# {==Heading==}" + comment + "\r\nNext paragraph",
		);
	});

	it("adjusts forward and backward CodeMirror selections identically", () => {
		const text = "# Heading\nNext paragraph";
		for (const [anchor, head] of [[0, 10], [10, 0]]) {
			const state = EditorState.create({ doc: text, selection: EditorSelection.single(anchor, head) });
			const { from, to } = state.selection.main;
			expect(state.doc.sliceString(from, to)).toBe("# Heading\n");
			expect(commentDraftContentRange(text, from, to)).toEqual({ from: 2, to: 9 });
			expect(state.selection.main.anchor).toBe(anchor);
		}
	});

	it.each([0, 1, 2, 3, 4, 5])("moves a start inside a task prefix (%i) after the box", (from) => {
		expect(insertComment("- [ ] Task", from, 10)).toBe("- [ ] {==Task==}" + comment);
	});

	it("leaves a partial content selection at its original offsets", () => {
		expect(insertComment("- one two three", 6, 9)).toBe("- one {==two==}" + comment + " three");
	});

	it.each(["plain text", "a\nparagraph", "#hashtag", "####### text", "1234567890. text", "-word", "\\# escaped", "---", "* * *"])(
		"leaves ordinary or unsupported syntax unchanged: %j", (text) => {
			expect(insertComment(text, 0, text.length)).toBe("{==" + text + "==}" + comment);
		},
	);

	it.each(["```md\n", "~~~\n", "````\n```\n"])("matches upstream narrowing for a code-text prefix (%j)", (fence) => {
		const text = fence + "# literal code\n";
		expect(commentDraftContentRange(text, fence.length, text.length)).toEqual(
			narrowAnchorRange(text, fence.length, text.length),
		);
		expect(insertComment(text, fence.length, text.length)).toBe(fence + "# {==literal code==}" + comment + "\n");
	});

	it("adjusts a block after a closed fence", () => {
		const before = "```md\n# code\n```\n";
		const text = before + "# Heading";
		expect(insertComment(text, before.length, text.length)).toBe(before + "# {==Heading==}" + comment);
	});

	it.each(["1. first\n2. second", "- first\n  continued", "# heading\nparagraph", "> first\n> second", "- [ ] task\n- next"])(
		"refuses a prefixed selection crossing lines: %j", (text) => {
			expect(commentDraftContentRange(text, 0, text.length)).toBeNull();
		},
	);

	it.each(["- ", "# ", "> ", "- [ ] "])("refuses a prefix-only selection: %j", (text) => {
		expect(commentDraftContentRange(text, 0, text.length)).toBeNull();
	});

	it.each(["1. item", "- item", "- [ ] task", "# heading", "> quote", "> - item"])(
		"refuses a selection starting before a later block: %j", (line) => {
			const text = "plain text\n" + line;
			expect(commentDraftContentRange(text, 0, text.length)).toBeNull();
			expect(commentDraftContentRange(text, 10, text.length)).toBeNull();
		},
	);

	it("does not include a block starting exactly at the selection end", () => {
		const text = "plain text\n- item";
		expect(commentDraftContentRange(text, 0, 11)).toEqual({ from: 0, to: 11 });
	});

	it("refuses even a partial later prefix using the full source line", () => {
		const text = "plain text\n- item";
		expect(commentDraftContentRange(text, 0, 12)).toBeNull();
		expect(commentDraftContentRange("\n- item", 0, 2)).toBeNull();
	});

	it.each(["    - ambiguous", "\t- ambiguous", "     # ambiguous", ">    - ambiguous", "> \t# ambiguous"])(
		"keeps indentation outside the anchor without guessing the block type: %j", (text) => {
			expect(commentDraftContentRange(text, 0, text.length)).toEqual({ from: text.indexOf("ambiguous"), to: text.length });
		},
	);

	it.each(["\t- ", "    - ", "\t\t- [ ] ", ">     ", "> \t- "])(
		"allows both whole-line and content-only nested selections: %j", (prefix) => {
			const before = "- parent\n";
			const text = before + prefix + "b c";
			const contentFrom = text.indexOf("b c");
			for (const from of [before.length, contentFrom]) {
				const range = commentDraftContentRange(text, from, text.length)!;
				expect(range).toEqual({ from: contentFrom, to: text.length });
				expect(narrowAnchorRange(text, range.from, range.to)).toEqual(range);
				expect(insertComment(text, from, text.length)).toBe(before + prefix + "{==b c==}" + comment);
			}
		},
	);

	it.each([
		["> ```\n", "> - literal code"],
		["- ```\n", "  # literal code"],
		["    ~~~\n", "    - literal code"],
	])("keeps nested code containers outside the mark: %j", (before, line) => {
		const text = before + line;
		const contentFrom = text.indexOf("literal code");
		expect(commentDraftContentRange(text, before.length, text.length)).toEqual({ from: contentFrom, to: text.length });
		expect(insertComment(text, before.length, text.length)).toBe(text.slice(0, contentFrom) + "{==literal code==}" + comment);
	});

	it("adjusts a block after a closed nested fence", () => {
		const before = "> ```\n> code\n> ```\n";
		const text = before + "# Heading";
		expect(insertComment(text, before.length, text.length)).toBe(before + "# {==Heading==}" + comment);
	});

	it("keeps empty selections at their surviving insertion point", () => {
		expect(insertComment("# Heading", 0, 0)).toBe(comment + "# Heading");
	});

	it("finds a complete native highlight after removing the block prefix", () => {
		const text = "# ==Heading==\nNext paragraph";
		const range = commentDraftContentRange(text, 0, 14)!;
		const highlight = findNativeHighlightForSelection(parseNativeHighlights(text, []), range.from, range.to);
		expect(highlight?.raw).toBe("==Heading==");
		const result = text.slice(0, highlight!.to) + comment + text.slice(highlight!.to);
		expect(result).toBe("# ==Heading==" + comment + "\nNext paragraph");
		expect(parseCriticMarkup(result).map((mark) => mark.type)).toEqual(["comment"]);
	});

	it("recomputes the content boundary after an entire mapped range is rewritten", () => {
		const text = "old text";
		const changes = ChangeSet.of({ from: 0, to: text.length, insert: "# New heading\n" }, text.length);
		const draft = mapCommentDraftAnchor({ id: 7, filePath: "note.md", from: 0, to: text.length }, changes);
		const updatedText = changes.apply(EditorState.create({ doc: text }).doc).toString();
		expect(insertComment(updatedText, draft.from, draft.to)).toBe("# {==New heading==}" + comment + "\n");
	});
});
