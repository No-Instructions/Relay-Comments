import { parseCriticMarkup } from "./parse";
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

export function applyAllMarkActions(text: string, action: CriticAction): string {
	const marks = parseCriticMarkup(text).filter((mark) => mark.valid);
	let next = text;
	for (let i = marks.length - 1; i >= 0; i--) {
		next = applyMarkAction(next, marks[i], action);
	}
	return next;
}
