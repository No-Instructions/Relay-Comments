import { describe, expect, it } from "@jest/globals";
import {
	clampPreviewSnippet,
	findPrecedingWordRange,
	formatMarkDate,
	normalizeWhitespace,
	rectDrifted,
} from "src/critic/display";
import { parseCriticMarkup } from "src/critic/parse";

describe("clampPreviewSnippet", () => {
	it("keeps short text intact", () => {
		expect(clampPreviewSnippet("one line")).toBe("one line");
	});

	it("keeps at most three non-empty lines with an ellipsis", () => {
		expect(clampPreviewSnippet("a\n\nb\nc\nd")).toBe("a\nb\nc…");
	});

	it("clamps very long text to 320 characters", () => {
		const long = "x".repeat(400);
		const result = clampPreviewSnippet(long);
		expect(result.length).toBe(318);
		expect(result.endsWith("…")).toBe(true);
	});
});

describe("findPrecedingWordRange", () => {
	it("returns null at line start", () => {
		expect(findPrecedingWordRange("abc\ndef", 4, [])).toBeNull();
	});

	it("walks back over spaces to the previous word", () => {
		const text = "hello   ";
		expect(findPrecedingWordRange(text, text.length, [])).toEqual([0, 5]);
	});

	it("returns null when the word overlaps another mark", () => {
		const text = "{++word++} {>>c<<}";
		const marks = parseCriticMarkup(text);
		// preceding word before the comment is the addition's closing "++}"
		expect(findPrecedingWordRange(text, marks[1].from, marks)).toBeNull();
	});
});

describe("formatMarkDate", () => {
	const mark = (date?: string) =>
		parseCriticMarkup(
			date ? `{{author="A" date="${date}">>x<<}}` : "{>>x<<}",
		)[0];

	it("returns null without date metadata", () => {
		expect(formatMarkDate(mark())).toBeNull();
	});

	it("passes unparseable dates through raw", () => {
		expect(formatMarkDate(mark("not-a-date"))).toBe("not-a-date");
	});

	it("formats valid dates like the sidebar does", () => {
		const expected = new Intl.DateTimeFormat(undefined, {
			month: "short",
			day: "numeric",
			year: "numeric",
		}).format(new Date("2026-07-04T12:00:00Z"));
		expect(formatMarkDate(mark("2026-07-04T12:00:00Z"))).toBe(expected);
	});
});

describe("normalizeWhitespace", () => {
	it("collapses runs and trims", () => {
		expect(normalizeWhitespace("  a\n\tb   c ")).toBe("a b c");
	});
});

describe("rectDrifted", () => {
	const rect = (top: number, left: number, width = 100, height = 20) => ({
		top,
		left,
		width,
		height,
	});

	it("tolerates sub-pixel jitter", () => {
		expect(rectDrifted(rect(10, 10), rect(11.5, 10))).toBe(false);
	});

	it("fires on real movement", () => {
		expect(rectDrifted(rect(10, 10), rect(16, 10))).toBe(true);
		expect(rectDrifted(rect(10, 10), rect(10, 30))).toBe(true);
	});

	it("fires when the anchor is resized", () => {
		expect(rectDrifted(rect(10, 10, 100), rect(10, 10, 60))).toBe(true);
	});
});
