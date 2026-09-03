import type { CriticMark } from "../critic/types";

export type HighlightColor =
	| "default"
	| "red"
	| "orange"
	| "green"
	| "blue"
	| "purple";

const COLOR_EMOJIS = [
	["🔴", "red"],
	["🟠", "orange"],
	["🟢", "green"],
	["🔵", "blue"],
	["🟣", "purple"],
] as const satisfies ReadonlyArray<readonly [string, Exclude<HighlightColor, "default">]>;

export interface HighlightPresentation {
	color: HighlightColor;
	emoji: string | null;
	/** Display text with the native color marker removed. */
	text: string;
	/** UTF-16 source length occupied by the marker and its optional spacer. */
	prefixLength: number;
}

export interface NativeHighlight {
	kind: "native-highlight";
	id: string;
	from: number;
	to: number;
	raw: string;
	text: string;
	contentFrom: number;
	contentTo: number;
	color: HighlightColor;
	emoji: string | null;
	line: number;
}

/** Interpret Obsidian 1.14's optional color emoji at the start of a highlight. */
export function highlightPresentation(content: string): HighlightPresentation {
	for (const [emoji, color] of COLOR_EMOJIS) {
		if (!content.startsWith(emoji)) continue;
		const spacerLength = content[emoji.length] === " " ? 1 : 0;
		const prefixLength = emoji.length + spacerLength;
		return {
			color,
			emoji,
			text: content.slice(prefixLength),
			prefixLength,
		};
	}
	return { color: "default", emoji: null, text: content, prefixLength: 0 };
}

export function highlightColorClass(color: HighlightColor): string {
	return `critic-highlight-color-${color}`;
}

/**
 * Parse native Obsidian Markdown highlights separately from CriticMarkup.
 * Critic ranges are excluded wholesale, including Markdown inside comment
 * bodies, so native document highlights never leak out of review markup.
 */
export function parseNativeHighlights(
	text: string,
	criticMarks: readonly CriticMark[],
): NativeHighlight[] {
	const excluded = criticMarks
		.map((mark) => [mark.from, mark.to] as const)
		.sort((left, right) => left[0] - right[0]);
	const highlights: NativeHighlight[] = [];
	const lines = text.split("\n");
	let lineFrom = 0;
	let fence: { marker: "`" | "~"; length: number } | null = null;

	for (let line = 0; line < lines.length; line += 1) {
		const source = lines[line];
		const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(source);
		if (fenceMatch) {
			const run = fenceMatch[1];
			const marker = run[0] as "`" | "~";
			if (!fence) {
				fence = { marker, length: run.length };
			} else if (fence.marker === marker && run.length >= fence.length) {
				fence = null;
			}
			lineFrom += source.length + 1;
			continue;
		}
		if (fence) {
			lineFrom += source.length + 1;
			continue;
		}

		let cursor = 0;
		while (cursor < source.length - 1) {
			if (source[cursor] === "`") {
				cursor = skipCodeSpan(source, cursor);
				continue;
			}
			if (
				source[cursor] !== "=" ||
				source[cursor + 1] !== "=" ||
				isEscaped(source, cursor) ||
				source[cursor - 1] === "=" ||
				source[cursor + 2] === "=" ||
				isWhitespace(source[cursor + 2])
			) {
				cursor += 1;
				continue;
			}

			const from = lineFrom + cursor;
			if (rangeContains(excluded, from)) {
				cursor += 2;
				continue;
			}
			const close = findHighlightClose(source, cursor + 2);
			if (close === -1) break;
			const to = lineFrom + close + 2;
			if (rangeOverlaps(excluded, from, to)) {
				cursor = close + 2;
				continue;
			}

			const rawContent = source.slice(cursor + 2, close);
			const presentation = highlightPresentation(rawContent);
			if (presentation.text.trim().length > 0) {
				const contentFrom = from + 2 + presentation.prefixLength;
				highlights.push({
					kind: "native-highlight",
					id: `native-highlight:${from}:${to}:${source.slice(cursor, close + 2)}`,
					from,
					to,
					raw: source.slice(cursor, close + 2),
					text: presentation.text,
					contentFrom,
					contentTo: lineFrom + close,
					color: presentation.color,
					emoji: presentation.emoji,
					line,
				});
			}
			cursor = close + 2;
		}

		lineFrom += source.length + 1;
	}

	return highlights;
}

export function findNativeHighlightAtOffset(
	highlights: readonly NativeHighlight[],
	offset: number,
): NativeHighlight | null {
	return (
		highlights.find(
			(highlight) => highlight.from <= offset && offset <= highlight.to,
		) ?? null
	);
}

export function findNativeHighlightForSelection(
	highlights: readonly NativeHighlight[],
	from: number,
	to: number,
): NativeHighlight | null {
	return (
		highlights.find(
			(highlight) =>
				(highlight.contentFrom === from && highlight.contentTo === to) ||
				(highlight.from === from && highlight.to === to),
		) ?? null
	);
}

function findHighlightClose(line: string, from: number): number {
	let cursor = from;
	while (cursor < line.length - 1) {
		if (line[cursor] === "`") {
			cursor = skipCodeSpan(line, cursor);
			continue;
		}
		if (
			line[cursor] === "=" &&
			line[cursor + 1] === "=" &&
			!isEscaped(line, cursor) &&
			line[cursor - 1] !== "=" &&
			line[cursor + 2] !== "=" &&
			!isWhitespace(line[cursor - 1])
		) {
			return cursor;
		}
		cursor += 1;
	}
	return -1;
}

function isWhitespace(character: string | undefined): boolean {
	return character === undefined || /\s/.test(character);
}

function skipCodeSpan(line: string, from: number): number {
	let length = 1;
	while (line[from + length] === "`") length += 1;
	const marker = "`".repeat(length);
	const close = line.indexOf(marker, from + length);
	return close === -1 ? line.length : close + length;
}

function isEscaped(text: string, offset: number): boolean {
	let slashes = 0;
	for (let index = offset - 1; index >= 0 && text[index] === "\\"; index -= 1) {
		slashes += 1;
	}
	return slashes % 2 === 1;
}

function rangeContains(
	ranges: ReadonlyArray<readonly [number, number]>,
	offset: number,
): boolean {
	let low = 0;
	let high = ranges.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (ranges[middle][1] <= offset) low = middle + 1;
		else high = middle;
	}
	const range = ranges[low];
	return range !== undefined && range[0] <= offset;
}

function rangeOverlaps(
	ranges: ReadonlyArray<readonly [number, number]>,
	from: number,
	to: number,
): boolean {
	let low = 0;
	let high = ranges.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (ranges[middle][1] <= from) low = middle + 1;
		else high = middle;
	}
	return ranges[low]?.[0] < to;
}
