import { describe, expect, it } from "@jest/globals";
import {
	renderDisplaySegments,
	renderSliceSegments,
} from "src/critic/render";

describe("renderDisplaySegments (review mode)", () => {
	it("renders suggestion marks as typed segments", () => {
		const segments = renderDisplaySegments(
			"Keep {++added++} and {--dropped--} here.",
			"review",
		);

		expect(segments).toEqual([
			{ kind: "text", text: "Keep " },
			{ kind: "addition", text: "added" },
			{ kind: "text", text: " and " },
			{ kind: "deletion", text: "dropped" },
			{ kind: "text", text: " here." },
		]);
	});

	it("renders a substitution as deletion followed by addition", () => {
		const segments = renderDisplaySegments("Use {~~old~>new~~}.", "review");

		expect(segments).toEqual([
			{ kind: "text", text: "Use " },
			{ kind: "deletion", text: "old" },
			{ kind: "addition", text: "new" },
			{ kind: "text", text: "." },
		]);
	});

	it("anchors a standalone comment to the preceding word", () => {
		const segments = renderDisplaySegments(
			"Start word {>>note<<} end",
			"review",
		);

		expect(segments).toEqual([
			{ kind: "text", text: "Start " },
			{ kind: "highlight", text: "word", title: "note" },
			{ kind: "text", text: " " },
			{ kind: "text", text: " end" },
		]);
	});

	it("drops comments with no visible text", () => {
		const segments = renderDisplaySegments("word {>>  <<} end", "review");

		expect(segments).toEqual([
			{ kind: "text", text: "word " },
			{ kind: "text", text: " end" },
		]);
	});

	it("drops a comment with no preceding word on its line", () => {
		const segments = renderDisplaySegments("{>>orphan<<} word", "review");

		expect(segments).toEqual([{ kind: "text", text: " word" }]);
	});

	it("keeps anchored thread comments out of the inline text", () => {
		const segments = renderDisplaySegments(
			'X {==hi==}{{author="A" date="2026-01-01">>threaded<<}} Y',
			"review",
		);

		expect(segments).toEqual([
			{ kind: "text", text: "X " },
			{ kind: "highlight", text: "hi" },
			{ kind: "text", text: " Y" },
		]);
	});

	it("hides the legacy single-newline separator inside a thread", () => {
		const segments = renderDisplaySegments(
			'{==hi==}\n{{author="A" date="2026-01-01">>threaded<<}}',
			"review",
		);

		expect(segments).toEqual([{ kind: "highlight", text: "hi" }]);
	});

	it("renders invalid markup as raw text so nothing disappears", () => {
		const segments = renderDisplaySegments("oops {++unclosed", "review");

		expect(segments).toEqual([
			{ kind: "text", text: "oops " },
			{ kind: "text", text: "{++unclosed" },
		]);
	});
});

describe("renderDisplaySegments (clean mode)", () => {
	it("applies additions and highlights, removes deletions and comments", () => {
		const segments = renderDisplaySegments(
			"Keep {++added++} drop {--gone--} mark {==kept==} note {>>hidden<<} end",
			"clean",
		);

		expect(segments.map((segment) => segment.text).join("")).toBe(
			"Keep added drop  mark kept note  end",
		);
		expect(segments.every((segment) => segment.kind === "text")).toBe(true);
	});

	it("keeps only the replacement text of a substitution", () => {
		const segments = renderDisplaySegments("Change {~~old~>new~~}.", "clean");

		expect(segments.map((segment) => segment.text).join("")).toBe(
			"Change new.",
		);
	});
});

describe("renderSliceSegments", () => {
	it("clips a mark straddling the slice end and hides its delimiters", () => {
		const text = "AB {==span==} CD";
		const segments = renderSliceSegments(text, 0, 8, "review");

		expect(segments).toEqual([
			{ kind: "text", text: "AB " },
			{ kind: "highlight", text: "sp" },
		]);
	});

	it("clips a mark straddling the slice start", () => {
		const text = "AB {==span==} CD";
		const segments = renderSliceSegments(text, 8, text.length, "review");

		expect(segments).toEqual([
			{ kind: "highlight", text: "an" },
			{ kind: "text", text: " CD" },
		]);
	});

	it("returns plain text for a slice with no marks", () => {
		const text = "AB {==span==} CD";
		const segments = renderSliceSegments(text, 14, text.length, "review");

		expect(segments).toEqual([{ kind: "text", text: "CD" }]);
	});
});
