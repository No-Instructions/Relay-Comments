import { COLOR_EMOJIS } from "../markdown/highlights";

export interface AnchorRange {
	from: number;
	to: number;
}

/** Length of the block syntax a line starts with: quote markers, then a
    heading marker or a list marker with its optional task box. */
export function structuralPrefixLength(line: string): number {
	let length = 0;
	let rest = line;
	for (;;) {
		const quote = /^[\t ]*>[\t ]?/.exec(rest);
		if (!quote) break;
		length += quote[0].length;
		rest = rest.slice(quote[0].length);
	}
	const block =
		/^[\t ]*(?:#{1,6}[\t ]+|(?:[-+*]|\d+[.)])[\t ]+(?:\[[ xX]\][\t ]+)?)/.exec(rest);
	if (block) length += block[0].length;
	return length;
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
