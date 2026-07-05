import { describe, expect, it } from "@jest/globals";
import {
	formatComposerSubmitHint,
	getComposerSubmitScopeBinding,
	isComposerSubmitKey,
	type SubmitKeyEvent,
} from "src/ui/composer-keys";

function key(overrides: Partial<SubmitKeyEvent>): SubmitKeyEvent {
	return {
		key: "Enter",
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...overrides,
	};
}

describe("isComposerSubmitKey (mod-enter)", () => {
	it("accepts Ctrl+Enter and Cmd+Enter", () => {
		expect(isComposerSubmitKey(key({ ctrlKey: true }), "mod-enter")).toBe(true);
		expect(isComposerSubmitKey(key({ metaKey: true }), "mod-enter")).toBe(true);
	});

	it("rejects plain Enter — it inserts a newline", () => {
		expect(isComposerSubmitKey(key({}), "mod-enter")).toBe(false);
	});

	it("rejects chords with extra modifiers", () => {
		expect(
			isComposerSubmitKey(key({ ctrlKey: true, shiftKey: true }), "mod-enter"),
		).toBe(false);
		expect(
			isComposerSubmitKey(key({ metaKey: true, altKey: true }), "mod-enter"),
		).toBe(false);
	});

	it("rejects non-Enter keys under the right modifiers", () => {
		expect(
			isComposerSubmitKey(key({ key: "s", ctrlKey: true }), "mod-enter"),
		).toBe(false);
	});
});

describe("isComposerSubmitKey (enter)", () => {
	it("accepts plain Enter only", () => {
		expect(isComposerSubmitKey(key({}), "enter")).toBe(true);
		expect(isComposerSubmitKey(key({ shiftKey: true }), "enter")).toBe(false);
		expect(isComposerSubmitKey(key({ ctrlKey: true }), "enter")).toBe(false);
	});
});

describe("getComposerSubmitScopeBinding", () => {
	it("matches the submit key mode", () => {
		expect(getComposerSubmitScopeBinding("mod-enter")).toEqual({
			modifiers: ["Mod"],
			key: "Enter",
		});
		expect(getComposerSubmitScopeBinding("enter")).toEqual({
			modifiers: [],
			key: "Enter",
		});
	});
});

describe("formatComposerSubmitHint", () => {
	it("names the platform modifier", () => {
		expect(formatComposerSubmitHint(true, "mod-enter")).toContain("Cmd+Enter");
		expect(formatComposerSubmitHint(false, "mod-enter")).toContain("Ctrl+Enter");
	});

	it("explains newline behavior in enter mode", () => {
		expect(formatComposerSubmitHint(false, "enter")).toContain("Shift+Enter");
	});
});
