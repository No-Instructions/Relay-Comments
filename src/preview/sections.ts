import { parseCriticMarkup } from "../critic/parse";

export interface SourceSection {
	text: string;
	lineStart: number;
	lineEnd: number;
}

export interface SourceRange {
	from: number;
	to: number;
}

/** True when a rendered Markdown section contains only part of a multiline
    comment. Obsidian renders block Markdown inside the comment as separate
    sections before our postprocessor runs; those sections belong only in the
    comment UI and must not remain in the note preview. */
export function isCommentOnlySection(section: SourceSection): boolean {
	const range = sectionSourceRange(section);
	if (!range) return false;
	return parseCriticMarkup(section.text).some(
		(mark) =>
			mark.valid &&
			mark.type === "comment" &&
			mark.raw.includes("\n") &&
			range.from >= mark.from &&
			range.to <= mark.to,
	);
}

/** Resolve the source represented by one rendered Markdown element.
 *
 * Obsidian reports the enclosing block's line range for every descendant of
 * complex blocks such as callouts. A list item inside a callout can therefore
 * receive the range for the callout title and every sibling item. Narrow list
 * items to the source line whose words best match their rendered text, then
 * skip the quote/list prefix that Obsidian already supplied structurally.
 */
export function renderedElementSourceRange(
	section: SourceSection,
	tagName: string,
	renderedText: string,
): SourceRange | null {
	const sectionRange = sectionSourceRange(section);
	if (!sectionRange) return null;
	if (tagName !== "LI") return sectionRange;

	const renderedWords = words(renderedText);
	if (renderedWords.length === 0) return null;
	const lines = lineRanges(section.text);
	let best: SourceRange | null = null;
	let bestScore = 0;
	for (
		let line = section.lineStart;
		line <= Math.min(section.lineEnd, lines.length - 1);
		line += 1
	) {
		const range = lines[line];
		const source = section.text.slice(range.from, range.to);
		const sourceWords = words(source);
		const score = sourceWords.filter((word) => renderedWords.includes(word)).length;
		if (score > bestScore) {
			best = range;
			bestScore = score;
		}
	}
	if (!best) return null;

	const source = section.text.slice(best.from, best.to);
	const prefixLength = sourcePrefixLength(source, tagName);
	return { from: best.from + prefixLength, to: best.to };
}

/** Footnotes are moved to a generated footer whose source line points past
    the end of the note. Return Obsidian's one-based footnote ordinals for
    references or definitions authored inside comments so that footer entries
    can still be removed without touching ordinary document footnotes. */
export function commentFootnoteOrdinals(text: string): Set<number> {
	const comments = parseCriticMarkup(text).filter(
		(mark) => mark.valid && mark.type === "comment",
	);
	if (comments.length === 0) return new Set();
	const insideComment = (offset: number): boolean =>
		comments.some(
			(comment) => offset >= comment.contentFrom && offset < comment.contentTo,
		);

	const commentLabels = new Set<string>();
	const definition = /^[\t ]{0,3}\[\^([^\]\r\n]+)\]:/gm;
	let match: RegExpExecArray | null;
	while ((match = definition.exec(text)) !== null) {
		if (insideComment(match.index)) commentLabels.add(match[1]);
	}

	const references: Array<{ label: string; offset: number }> = [];
	const reference = /\[\^([^\]\r\n]+)\]/g;
	while ((match = reference.exec(text)) !== null) {
		if (text[reference.lastIndex] === ":") continue;
		references.push({ label: match[1], offset: match.index });
		if (insideComment(match.index)) commentLabels.add(match[1]);
	}

	const ordinals = new Set<number>();
	const seen = new Set<string>();
	let ordinal = 0;
	for (const item of references) {
		if (seen.has(item.label)) continue;
		seen.add(item.label);
		ordinal += 1;
		if (commentLabels.has(item.label)) ordinals.add(ordinal);
	}
	return ordinals;
}

export function sectionSourceRange(
	section: SourceSection,
): { from: number; to: number } | null {
	const lines = lineRanges(section.text);
	if (
		section.lineStart < 0 ||
		section.lineEnd < section.lineStart ||
		section.lineStart >= lines.length
	) {
		return null;
	}
	const lastLine = Math.min(section.lineEnd, lines.length - 1);
	return {
		from: lines[section.lineStart].from,
		to: lines[lastLine].to,
	};
}

function lineRanges(text: string): SourceRange[] {
	const ranges: SourceRange[] = [];
	let from = 0;
	for (let offset = 0; offset <= text.length; offset += 1) {
		if (offset !== text.length && text[offset] !== "\n") continue;
		ranges.push({ from, to: offset });
		from = offset + 1;
	}
	return ranges;
}

function sourcePrefixLength(source: string, tagName: string): number {
	let length = 0;
	let rest = source;
	while (true) {
		const quote = /^[\t ]*>[\t ]?/.exec(rest);
		if (!quote) break;
		length += quote[0].length;
		rest = rest.slice(quote[0].length);
	}
	if (tagName === "LI") {
		const list = /^[\t ]*(?:[-+*]|\d+[.)])[\t ]+/.exec(rest);
		if (list) length += list[0].length;
	}
	return length;
}

function words(text: string): string[] {
	return Array.from(
		new Set(text.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 1) ?? []),
	);
}
