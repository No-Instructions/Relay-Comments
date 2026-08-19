import type { Hotkey } from "obsidian";

export type AddCommentTarget = "markdown" | "canvas";

export function getAddCommentTarget(
	viewType: string | null | undefined,
): AddCommentTarget | null {
	if (viewType === "markdown" || viewType === "canvas") return viewType;
	return null;
}

/**
 * The standard "add a comment" chord (as in Google Docs): Ctrl+Alt+M on
 * Windows/Linux, Command+Option+M on macOS.
 */
export const ADD_COMMENT_HOTKEYS: Hotkey[] = [
	{ modifiers: ["Mod", "Alt"], key: "m" },
	// On common macOS layouts Option-M types "µ", so the physical
	// Command-Option-M chord arrives with KeyboardEvent.key === "µ".
	{ modifiers: ["Mod", "Alt"], key: "µ" },
];
