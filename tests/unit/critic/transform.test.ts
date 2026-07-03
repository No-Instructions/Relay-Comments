import { describe, expect, it } from "@jest/globals";
import { parseCriticMarkup } from "src/critic/parse";
import {
	applyMarkAction,
	replacementForMark,
} from "src/critic/transform";

describe("replacementForMark", () => {
	it("returns accept and reject text for each mark type", () => {
		const marks = parseCriticMarkup(
			"{++add++} {--delete--} {~~old~>new~~} {==keep==} {>>note<<}",
		);

		expect(marks.map((mark) => replacementForMark(mark, "accept"))).toEqual([
			"add",
			"",
			"new",
			"keep",
			"",
		]);
		expect(marks.map((mark) => replacementForMark(mark, "reject"))).toEqual([
			"",
			"delete",
			"old",
			"keep",
			"",
		]);
	});
});

describe("applyMarkAction", () => {
	it("applies a single mark replacement while preserving surrounding text", () => {
		const text = "A {~~rough~>better~~} draft.";
		const [mark] = parseCriticMarkup(text);

		expect(applyMarkAction(text, mark, "accept")).toBe("A better draft.");
		expect(applyMarkAction(text, mark, "reject")).toBe("A rough draft.");
	});

	it("leaves invalid marks unchanged", () => {
		const text = "A {++broken";
		const [mark] = parseCriticMarkup(text);

		expect(applyMarkAction(text, mark, "accept")).toBe(text);
	});
});
