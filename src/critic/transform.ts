import type { CriticMark } from "./types";

export type CriticAction = "accept" | "reject";

export function replacementForMark(
	mark: CriticMark,
	action: CriticAction,
): string {
	switch (mark.type) {
		case "addition":
			return action === "accept" ? mark.content : "";
		case "deletion":
			return action === "accept" ? "" : mark.content;
		case "substitution":
			return action === "accept"
				? mark.newText ?? ""
				: mark.oldText ?? "";
		case "comment":
			return "";
		case "highlight":
			return mark.content;
	}
}

export function applyMarkAction(
	text: string,
	mark: CriticMark,
	action: CriticAction,
): string {
	if (!mark.valid) return text;
	return (
		text.slice(0, mark.from) +
		replacementForMark(mark, action) +
		text.slice(mark.to)
	);
}
