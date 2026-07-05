import type { Modifier } from "obsidian";

export type ComposerSubmitKey = "mod-enter" | "enter";

/** The chord that submits a sidebar composer. */
export const COMPOSER_SUBMIT_KEY: ComposerSubmitKey = "mod-enter";

export interface SubmitKeyEvent {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

export function isComposerSubmitKey(
	event: SubmitKeyEvent,
	submitKey: ComposerSubmitKey = COMPOSER_SUBMIT_KEY,
): boolean {
	if (event.key !== "Enter") return false;
	if (submitKey === "enter") {
		return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
	}
	return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
}

export function getComposerSubmitScopeBinding(
	submitKey: ComposerSubmitKey = COMPOSER_SUBMIT_KEY,
): { modifiers: Modifier[]; key: string } {
	if (submitKey === "enter") {
		return { modifiers: [], key: "Enter" };
	}
	return { modifiers: ["Mod"], key: "Enter" };
}

export function formatComposerSubmitHint(
	isMacOS: boolean,
	submitKey: ComposerSubmitKey = COMPOSER_SUBMIT_KEY,
): string {
	if (submitKey === "enter") {
		return "Enter to submit · Shift+Enter for newline · Esc to cancel";
	}
	return `${isMacOS ? "Cmd" : "Ctrl"}+Enter to submit · Esc to cancel`;
}
