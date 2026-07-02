import { parseCriticMarkup } from "./parse";
import type { CriticMark, DisplayMode, RenderSegment } from "./types";

export function renderDisplaySegments(
	text: string,
	mode: DisplayMode,
): RenderSegment[] {
	const marks = parseCriticMarkup(text);
	const anchoredCommentIds = findAnchoredCommentIds(marks);
	const segments: RenderSegment[] = [];
	let cursor = 0;

	for (const mark of marks) {
		if (mark.from < cursor) continue;
		if (mark.from > cursor) {
			segments.push({ kind: "text", text: text.slice(cursor, mark.from) });
		}
		if (mark.valid && anchoredCommentIds.has(mark.id)) {
			segments.push(...renderMarkSegments(mark, "clean"));
		} else if (mark.valid) {
			segments.push(...renderMarkSegments(mark, mode));
		} else {
			segments.push({ kind: "text", text: getInvalidMarkFallback(mark) });
		}
		cursor = mark.to;
	}

	if (cursor < text.length) {
		segments.push({ kind: "text", text: text.slice(cursor) });
	}

	return segments;
}

export function renderMarkSegments(
	mark: CriticMark,
	mode: DisplayMode,
): RenderSegment[] {
	if (mode === "clean") {
		switch (mark.type) {
			case "addition":
				return [{ kind: "text", text: mark.content }];
			case "deletion":
			case "comment":
				return [];
			case "substitution":
				return [{ kind: "text", text: mark.newText ?? "" }];
			case "highlight":
				return [{ kind: "text", text: mark.content }];
		}
	}

	switch (mark.type) {
		case "addition":
			return [{ kind: "addition", text: mark.content }];
		case "deletion":
			return [{ kind: "deletion", text: mark.content }];
		case "substitution":
			return [
				{ kind: "deletion", text: mark.oldText ?? "" },
				{ kind: "text", text: " -> " },
				{ kind: "addition", text: mark.newText ?? "" },
			];
		case "comment":
			return [{ kind: "comment", text: "", title: mark.content }];
		case "highlight":
			return [{ kind: "highlight", text: mark.content }];
	}
}

function findAnchoredCommentIds(marks: CriticMark[]): Set<string> {
	const ids = new Set<string>();
	for (let index = 0; index < marks.length; index += 1) {
		const mark = marks[index];
		if (!mark.valid || mark.type !== "highlight") continue;
		const comment = marks.find(
			(candidate, candidateIndex) =>
				candidateIndex > index &&
				candidate.valid &&
				candidate.type === "comment" &&
				candidate.from === mark.to,
		);
		if (comment) ids.add(comment.id);
	}
	return ids;
}

function getInvalidMarkFallback(mark: CriticMark): string {
	if (mark.type === "substitution") {
		return mark.newText ?? mark.oldText ?? mark.content;
	}
	return mark.content;
}

export function getMarkTitle(mark: CriticMark): string {
	switch (mark.type) {
		case "addition":
			return "Addition";
		case "deletion":
			return "Deletion";
		case "substitution":
			return "Substitution";
		case "comment":
			return "Comment";
		case "highlight":
			return "Highlight";
	}
}

export function getMarkSummary(mark: CriticMark): string {
	switch (mark.type) {
		case "addition":
		case "deletion":
		case "comment":
		case "highlight":
			return mark.content;
		case "substitution":
			return `${mark.oldText ?? ""} -> ${mark.newText ?? ""}`;
	}
}
