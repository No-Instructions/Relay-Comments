import { describe, expect, it } from "@jest/globals";
import { ADD_COMMENT_HOTKEYS } from "src/editor/hotkeys";

describe("ADD_COMMENT_HOTKEYS", () => {
	it("binds the standard comment chord", () => {
		expect(ADD_COMMENT_HOTKEYS).toContainEqual({
			modifiers: ["Mod", "Alt"],
			key: "m",
		});
	});

	it("keeps the macOS Option-M variant", () => {
		// Option-M types µ (U+00B5) on common macOS layouts, so the physical
		// Command-Option-M chord reaches Obsidian with key "µ" rather than
		// "m". Removing this entry breaks the chord on those layouts.
		expect(ADD_COMMENT_HOTKEYS).toContainEqual({
			modifiers: ["Mod", "Alt"],
			key: "µ",
		});
	});

	it("uses the same modifiers for every key variant", () => {
		for (const hotkey of ADD_COMMENT_HOTKEYS) {
			expect(hotkey.modifiers).toEqual(["Mod", "Alt"]);
		}
	});
});
