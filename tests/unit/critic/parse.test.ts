import { describe, expect, it } from "@jest/globals";
import {
	findFirstMarkInRange,
	findMarkAtOffset,
	parseCriticMarkup,
} from "src/critic/parse";

describe("parseCriticMarkup", () => {
	it("parses core CriticMarkup marks in document order", () => {
		const marks = parseCriticMarkup(
			"Start {++add++} {--drop--} {~~old~>new~~} {==note==} {>>comment<<}",
		);

		expect(marks.map((mark) => mark.type)).toEqual([
			"addition",
			"deletion",
			"substitution",
			"highlight",
			"comment",
		]);
		expect(marks.every((mark) => mark.valid)).toBe(true);
		expect(marks[0]).toMatchObject({
			type: "addition",
			content: "add",
			ranges: { opening: [6, 9], closing: [12, 15] },
		});
	});

	it("parses substitution old/new ranges", () => {
		const [mark] = parseCriticMarkup("Use {~~alpha~>beta~~} here.");

		expect(mark).toMatchObject({
			type: "substitution",
			content: "alpha~>beta",
			oldText: "alpha",
			newText: "beta",
			valid: true,
		});
		expect(mark.ranges.oldText).toEqual([7, 12]);
		expect(mark.ranges.separator).toEqual([12, 14]);
		expect(mark.ranges.newText).toEqual([14, 18]);
	});

	it("parses metadata comments used by Relay Comments", () => {
		const text =
			'{{authorId="u123" author="Dana" date="2026-07-03T17:00:00.000Z">>Looks right<<}}';
		const [mark] = parseCriticMarkup(text);

		expect(mark).toMatchObject({
			type: "comment",
			content: "Looks right",
			metadataRaw:
				'authorId="u123" author="Dana" date="2026-07-03T17:00:00.000Z"',
			metadata: {
				authorId: "u123",
				author: "Dana",
				date: "2026-07-03T17:00:00.000Z",
			},
			valid: true,
		});
		expect(mark.ranges.commentText).toEqual([
			text.indexOf("Looks right"),
			text.indexOf("Looks right") + "Looks right".length,
		]);
	});

	it("limits an unclosed mark to its own line", () => {
		const marks = parseCriticMarkup("first {++unfinished\nsecond {--gone--}");

		expect(marks).toHaveLength(2);
		expect(marks[0]).toMatchObject({
			type: "addition",
			raw: "{++unfinished",
			valid: false,
			error: "Unclosed CriticMarkup mark.",
			line: 0,
		});
		expect(marks[1]).toMatchObject({
			type: "deletion",
			content: "gone",
			valid: true,
			line: 1,
		});
	});

	it("marks nested syntax invalid without dropping the parsed range", () => {
		const [mark] = parseCriticMarkup("{==outer {++inner++}==}");

		expect(mark).toMatchObject({
			type: "highlight",
			content: "outer {++inner++}",
			valid: false,
			error: "Nested CriticMarkup is not supported yet.",
		});
	});
});

describe("mark lookup", () => {
	it("finds marks by cursor offset and selected range", () => {
		const text = "Keep {--old--} and {++new++}.";
		const marks = parseCriticMarkup(text);

		expect(findMarkAtOffset(marks, text.indexOf("old"))?.type).toBe("deletion");
		expect(
			findFirstMarkInRange(marks, text.indexOf("and"), text.indexOf("new"))
				?.type,
		).toBe("addition");
		expect(findMarkAtOffset(marks, 0)).toBeNull();
	});
});
