import { ChangeSet, EditorSelection, EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "@jest/globals";
import {
	narrowAnchorRange,
	structuralPrefixLength,
} from "src/critic/anchor-range";
import { parseCriticMarkup } from "src/critic/parse";
import { buildCommentDraftInsertion, mapCommentDraftAnchor } from "src/editor/comment-draft-anchor";
import { findNativeHighlightForSelection, parseNativeHighlights } from "src/markdown/highlights";

describe("structuralPrefixLength", () => {
	it.each([
		["- > quoted", 4],
		["> - [ ] task", 8],
		["\t\t- [ ] task", 8],
		["> > ### heading", 8],
		["* * *", 0],
		["- - -", 0],
		["1234567890. prose", 0],
		["> [!note] Title", 10],
		["> [!warning]- Folded", 14],
		["> [!tip]", 8],
		["> > [!note] Nested", 12],
		["- [!note] not a callout", 2],
		["[!note] not a callout", 0],
	])("uses shared block syntax rules for %j", (line, length) => {
		expect(structuralPrefixLength(line)).toBe(length);
	});

	it("measures heading, list, task, and quote syntax", () => {
		expect(structuralPrefixLength("## Must fix")).toBe(3);
		expect(structuralPrefixLength("- item")).toBe(2);
		expect(structuralPrefixLength("1. item")).toBe(3);
		expect(structuralPrefixLength("- [ ] task")).toBe(6);
		expect(structuralPrefixLength("> > ### quoted")).toBe(8);
		expect(structuralPrefixLength("plain prose")).toBe(0);
	});
});

describe("narrowAnchorRange", () => {
	const text = "## Must fix\n\nFirst item.\n";

	it("keeps a heading marker outside the anchor", () => {
		expect(narrowAnchorRange(text, 0, 11)).toEqual({ from: 3, to: 11 });
	});

	it("drops the newline a triple-click selects", () => {
		expect(narrowAnchorRange(text, 0, 12)).toEqual({ from: 3, to: 11 });
	});

	it("moves a start inside the marker past it", () => {
		expect(narrowAnchorRange(text, 1, 11)).toEqual({ from: 3, to: 11 });
	});

	it("leaves prose selections alone", () => {
		expect(narrowAnchorRange(text, 13, 24)).toEqual({ from: 13, to: 24 });
	});

	it("returns null when only syntax or whitespace is selected", () => {
		expect(narrowAnchorRange(text, 0, 3)).toBeNull();
		expect(narrowAnchorRange(text, 11, 13)).toBeNull();
	});

	it("keeps a literal colour emoji outside the anchor", () => {
		const note = "## 🔴 Important\n";
		expect(narrowAnchorRange(note, 0, note.length - 1)).toEqual({ from: 6, to: 15 });
		expect(narrowAnchorRange("🔵 plain", 0, 8)).toEqual({ from: 3, to: 8 });
		expect(narrowAnchorRange("## 🔴 🔵 Heading", 0, 16)).toEqual({ from: 9, to: 16 });
	});

	it("narrows only the first line of a multi-line selection", () => {
		expect(narrowAnchorRange(text, 0, 24)).toEqual({ from: 3, to: 24 });
	});
});

describe("narrowAnchorRange inside block syntax", () => {
	const comment = '{{authorId="reviewer" author="Reviewer">>test<<}}';

	function insertComment(documentText: string, from: number, to: number): string {
		const range = narrowAnchorRange(documentText, from, to);
		if (!range) throw new Error("Unsupported comment range");
		return documentText.slice(0, range.from)
			+ buildCommentDraftInsertion(documentText.slice(range.from, range.to), comment)
			+ documentText.slice(range.to);
	}

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
		}
	});

	it("keeps a callout's type marker outside the comment", () => {
		const text = "> [!note] Callout title\n> Body";
		expect(insertComment(text, 0, text.indexOf("\n") + 1)).toBe(
			"> [!note] {==Callout title==}" + comment + "\n> Body",
		);
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
			expect(narrowAnchorRange(text, from, to)).toEqual({ from: 2, to: 9 });
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

	it.each(["```md\n", "~~~\n", "````\n```\n"])("narrows a code-text prefix like any other line (%j)", (fence) => {
		const text = fence + "# literal code\n";
		expect(insertComment(text, fence.length, text.length)).toBe(fence + "# {==literal code==}" + comment + "\n");
	});

	it("adjusts a block after a closed fence", () => {
		const before = "```md\n# code\n```\n";
		const text = before + "# Heading";
		expect(insertComment(text, before.length, text.length)).toBe(before + "# {==Heading==}" + comment);
	});

	it.each(["1. first\n2. second", "> first\n> second", "- [ ] task\n- next"])(
		"refuses a selection that runs into a later block line: %j", (text) => {
			expect(narrowAnchorRange(text, 0, text.length)).toBeNull();
		},
	);

	it.each([["- first\n  continued", 2], ["# heading\nparagraph", 2]])(
		"keeps a prefixed first line's mark when the later lines are plain: %j", (text, from) => {
			expect(narrowAnchorRange(text, 0, text.length)).toEqual({ from, to: text.length });
		},
	);

	it.each(["- ", "# ", "> ", "- [ ] "])("refuses a prefix-only selection: %j", (text) => {
		expect(narrowAnchorRange(text, 0, text.length)).toBeNull();
	});

	it.each(["1. item", "- item", "- [ ] task", "# heading", "> quote", "> - item"])(
		"refuses a selection starting before a later block: %j", (line) => {
			const text = "plain text\n" + line;
			expect(narrowAnchorRange(text, 0, text.length)).toBeNull();
		},
	);

	it("starts after the block syntax when only the line break precedes it", () => {
		const text = "plain text\n- item";
		expect(narrowAnchorRange(text, 10, text.length)).toEqual({ from: 13, to: 17 });
	});

	it("does not include a block starting exactly at the selection end", () => {
		const text = "plain text\n- item";
		expect(narrowAnchorRange(text, 0, 11)).toEqual({ from: 0, to: 10 });
	});

	it("refuses even a partial later prefix using the full source line", () => {
		const text = "plain text\n- item";
		expect(narrowAnchorRange(text, 0, 12)).toBeNull();
		expect(narrowAnchorRange("\n- item", 0, 2)).toBeNull();
	});

	it.each(["    - ambiguous", "\t- ambiguous", "     # ambiguous", ">    - ambiguous", "> \t# ambiguous"])(
		"keeps indentation outside the anchor without guessing the block type: %j", (text) => {
			expect(narrowAnchorRange(text, 0, text.length)).toEqual({ from: text.indexOf("ambiguous"), to: text.length });
		},
	);

	it.each(["\t- ", "    - ", "\t\t- [ ] ", ">     ", "> \t- "])(
		"allows both whole-line and content-only nested selections: %j", (prefix) => {
			const before = "- parent\n";
			const text = before + prefix + "b c";
			const contentFrom = text.indexOf("b c");
			for (const from of [before.length, contentFrom]) {
				expect(narrowAnchorRange(text, from, text.length)).toEqual({ from: contentFrom, to: text.length });
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
		expect(narrowAnchorRange(text, before.length, text.length)).toEqual({ from: contentFrom, to: text.length });
	});

	it("adjusts a block after a closed nested fence", () => {
		const before = "> ```\n> code\n> ```\n";
		const text = before + "# Heading";
		expect(insertComment(text, before.length, text.length)).toBe(before + "# {==Heading==}" + comment);
	});

	it("finds a complete native highlight after removing the block prefix", () => {
		const text = "# ==Heading==\nNext paragraph";
		const range = narrowAnchorRange(text, 0, 14)!;
		const highlight = findNativeHighlightForSelection(parseNativeHighlights(text, []), range.from, range.to);
		expect(highlight?.raw).toBe("==Heading==");
	});

	it("recomputes the content boundary after an entire mapped range is rewritten", () => {
		const text = "old text";
		const changes = ChangeSet.of({ from: 0, to: text.length, insert: "# New heading\n" }, text.length);
		const draft = mapCommentDraftAnchor({ id: 7, filePath: "note.md", from: 0, to: text.length }, changes, Text.of([text]));
		const updatedText = changes.apply(Text.of([text])).toString();
		expect(insertComment(updatedText, draft.from, draft.to)).toBe("# {==New heading==}" + comment + "\n");
	});
});
