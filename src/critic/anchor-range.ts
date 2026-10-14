import { COLOR_EMOJIS } from "../markdown/highlights";

export interface AnchorRange {
	from: number;
	to: number;
}

/** Length of a line's quote/list containers, task box, and heading marker. */
export function structuralPrefixLength(line: string): number {
	let cursor = /^[ \t]*/.exec(line)![0].length;
	let hasPrefix = false;
	while (cursor < line.length) {
		const quote = /^>[ \t]*/.exec(line.slice(cursor));
		const list = /^(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(line.slice(cursor));
		const marker = quote ?? list;
		if (!marker) break;
		if (list && /^(?:\*[ \t]*){3,}$|^(?:-[ \t]*){3,}$/.test(line.slice(cursor))) break;
		cursor += marker[0].length;
		hasPrefix = true;
		if (list) {
			cursor += /^\[[ xX]\][ \t]+/.exec(line.slice(cursor))?.[0].length ?? 0;
		}
	}
	const heading = /^#{1,6}[ \t]+/.exec(line.slice(cursor));
	if (heading) {
		cursor += heading[0].length;
		hasPrefix = true;
	}
	return hasPrefix ? cursor : 0;
}

/**
 * The part of a selection an anchor mark may wrap. Surrounding whitespace is
 * dropped, and a selection that begins inside a line's block syntax starts
 * after it: `{==## Heading==}` is no longer a heading, `## {==Heading==}` is.
 * Returns null when nothing anchorable remains.
 */
export function narrowAnchorRange(
	text: string,
	from: number,
	to: number,
): AnchorRange | null {
	let start = Math.max(0, Math.min(from, to));
	let end = Math.min(text.length, Math.max(from, to));
	while (start < end && /\s/.test(text[start])) start += 1;
	while (end > start && /\s/.test(text[end - 1])) end -= 1;
	if (start >= end) return null;

	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	const lineEnd = text.indexOf("\n", lineStart);
	const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
	const prefixEnd = lineStart + structuralPrefixLength(line);
	if (start < prefixEnd) start = prefixEnd;
	while (start < end && /\s/.test(text[start])) start += 1;
	// A colour emoji at the start of a highlight is a marker that resolving
	// removes, so literal ones in the note stay outside the anchor.
	for (;;) {
		const marker = COLOR_EMOJIS.find(([emoji]) => text.startsWith(emoji, start));
		if (!marker) break;
		start += marker[0].length;
		while (start < end && /\s/.test(text[start])) start += 1;
	}
	return start < end ? { from: start, to: end } : null;
}
