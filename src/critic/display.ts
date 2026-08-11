import type { CriticMark } from "./types";

const markDateFormatter = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
});

/** Collapse runs of whitespace for one-line display contexts. */
export function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function normalizeQuoteText(value: string): string {
	// One pattern for every position a marker can end at: trailing
	// whitespace, a newline (bare marker on an interior line), or the
	// end of the quote.
	return normalizeWhitespace(
		value.replace(
			/(^|\n)([\t ]*)(?:[-*+]|\d+[.)])[\t ]+\[[ xX]\](?:[\t ]+|(?=\n)|$)/g,
			"$1$2",
		),
	);
}

export function isSuggestionMark(mark: CriticMark): boolean {
	return (
		mark.type === "addition" ||
		mark.type === "deletion" ||
		mark.type === "substitution"
	);
}

/**
 * Label and body for a suggestion's hover popover. Null for mark types
 * that are not suggestions (comments and highlights have their own
 * preview path).
 */
export function getSuggestionPreviewParts(
	mark: CriticMark,
): { label: string; snippet: string } | null {
	switch (mark.type) {
		case "addition":
			return { label: "Suggested addition", snippet: mark.content };
		case "deletion":
			return { label: "Suggested deletion", snippet: mark.content };
		case "substitution":
			return {
				label: "Suggested replacement",
				snippet: [mark.oldText, mark.newText]
					.map((value) => normalizeWhitespace(value ?? ""))
					.filter((value) => value.length > 0)
					.join(" → "),
			};
		default:
			return null;
	}
}

/** Human date from a mark's metadata; raw string when unparseable. */
export function formatMarkDate(mark: CriticMark): string | null {
	const raw = mark.metadata?.date?.trim();
	if (!raw) return null;
	const date = new Date(raw);
	if (Number.isNaN(date.getTime())) return raw;
	return markDateFormatter.format(date);
}

/**
 * The word immediately before `from` on the same line, used to anchor a
 * standalone comment to visible text. Returns null when the line starts at
 * the comment or the candidate range touches other CriticMarkup marks.
 */
export function findPrecedingWordRange(
	text: string,
	from: number,
	marks: CriticMark[],
): [number, number] | null {
	let end = from;
	while (end > 0) {
		const char = text[end - 1];
		if (char === "\n") return null;
		if (char === " " || char === "\t") {
			end -= 1;
			continue;
		}
		break;
	}
	if (end === 0) return null;
	let start = end;
	while (start > 0) {
		const char = text[start - 1];
		if (char === "\n" || char === " " || char === "\t") break;
		start -= 1;
	}
	if (end <= start) return null;
	const touchesMark = marks.some(
		(mark) => mark.from < end && mark.to > start,
	);
	return touchesMark ? null : [start, end];
}

/** First three non-empty lines, at most 320 characters, ellipsis beyond. */
export function clampPreviewSnippet(value: string): string {
	const lines = value
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const clipped = lines.slice(0, 3).join("\n");
	const suffix = lines.length > 3 ? "…" : "";
	if (clipped.length <= 320) return `${clipped}${suffix}`;
	let cut = clipped.slice(0, 317);
	// Never cut mid-token: a split token reads wrong, and a split URL
	// would linkify into a plausible-looking truncated href downstream
	// (the preview renders snippets through the comment-link parser).
	// A single token longer than the whole budget keeps the hard cut.
	if (/\S$/.test(cut) && /\S/.test(clipped.charAt(317))) {
		const lastBreak = cut.search(/\s\S*$/);
		if (lastBreak !== -1) cut = cut.slice(0, lastBreak);
	}
	return `${cut.trimEnd()}…`;
}

export interface RectLike {
	top: number;
	left: number;
	width: number;
	height: number;
}

/**
 * Whether an anchored overlay's reference rect has moved or resized enough
 * that the overlay is no longer where the user saw it appear.
 */
export function rectDrifted(a: RectLike, b: RectLike, tolerance = 2): boolean {
	return (
		Math.abs(a.top - b.top) > tolerance ||
		Math.abs(a.left - b.left) > tolerance ||
		Math.abs(a.width - b.width) > tolerance ||
		Math.abs(a.height - b.height) > tolerance
	);
}
