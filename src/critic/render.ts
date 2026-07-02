import { parseCriticMarkup } from "./parse";
import { collectAttachedComments } from "./threading";
import type { CriticMark, DisplayMode, RenderSegment } from "./types";

export function renderDisplaySegments(
	text: string,
	mode: DisplayMode,
): RenderSegment[] {
	const marks = parseCriticMarkup(text);
	const anchored = findAnchoredCommentMarkup(marks, text);
	const segments: RenderSegment[] = [];
	let cursor = 0;

	for (const mark of marks) {
		if (mark.from < cursor) continue;
		if (mark.from > cursor) {
			const separatorEnd = anchored.separatorEndByStart.get(cursor);
			if (separatorEnd !== mark.from) {
				segments.push({ kind: "text", text: text.slice(cursor, mark.from) });
			}
		}
		if (mark.valid && anchored.commentIds.has(mark.id)) {
			// Anchored comment bodies belong in the review sidebar, not inline text.
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
				return [];
			case "comment":
				return [{ kind: "text", text: mark.content }];
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
				{ kind: "addition", text: mark.newText ?? "" },
			];
		case "comment":
			return [{ kind: "text", text: mark.content }];
		case "highlight":
			return [{ kind: "highlight", text: mark.content }];
	}
}

function findAnchoredCommentMarkup(
	marks: CriticMark[],
	text: string,
): {
	commentIds: Set<string>;
	separatorEndByStart: Map<number, number>;
} {
	const commentIds = new Set<string>();
	const separatorEndByStart = new Map<number, number>();
	for (let index = 0; index < marks.length; index += 1) {
		const mark = marks[index];
		if (!mark.valid || commentIds.has(mark.id)) continue;

		const attached = collectAttachedComments(marks, text, index, commentIds);
		for (const comment of attached.comments) {
			commentIds.add(comment.id);
		}
		for (const [from, to] of attached.separatorRanges) {
			separatorEndByStart.set(from, to);
		}
	}
	return { commentIds, separatorEndByStart };
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
			return `${mark.oldText ?? ""}${mark.newText ?? ""}`;
	}
}
