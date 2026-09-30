import { describe, expect, it } from "@jest/globals";
import {
	narrowAnchorRange,
	structuralPrefixLength,
} from "src/critic/anchor-range";

describe("structuralPrefixLength", () => {
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
