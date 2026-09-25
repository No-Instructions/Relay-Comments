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

export interface RenderedElementOptions {
	/** Column of a table cell (`td`/`th`) within its row. */
	cellIndex?: number;
}

/**
 * The source slice one rendered element stands for: list items and table cells
 * narrow to their best-matching line (cells to their column), and every kind
 * drops the quote, heading, or list prefix Obsidian rendered structurally.
 */
export function renderedElementSourceRange(
	section: SourceSection,
	tagName: string,
	renderedText: string,
	options: RenderedElementOptions = {},
): SourceRange | null {
	const sectionRange = sectionSourceRange(section);
	if (!sectionRange) return null;
	const isCell = tagName === "TD" || tagName === "TH";

	let line: SourceRange | null;
	if (tagName === "LI" || isCell) {
		line = bestMatchingLine(section, renderedText);
	} else if (section.lineStart === section.lineEnd) {
		line = sectionRange;
	} else {
		return sectionRange;
	}
	if (!line) return null;

	const source = section.text.slice(line.from, line.to);
	const prefixLength = sourcePrefixLength(source, tagName);
	if (!isCell) return { from: line.from + prefixLength, to: line.to };

	const cell = tableCellRange(source.slice(prefixLength), options.cellIndex ?? 0);
	if (!cell) return null;
	return {
		from: line.from + prefixLength + cell.from,
		to: line.from + prefixLength + cell.to,
	};
}

/** The source line inside a section whose words best match rendered text. */
function bestMatchingLine(
	section: SourceSection,
	renderedText: string,
): SourceRange | null {
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
	return best;
}

/** The trimmed slice of one cell in a table row, splitting on unescaped pipes as Obsidian does. */
export function tableCellRange(
	row: string,
	cellIndex: number,
): SourceRange | null {
	if (cellIndex < 0) return null;
	const spans: SourceRange[] = [];
	let start = 0;
	for (let offset = 0; offset < row.length; offset += 1) {
		if (row[offset] !== "|" || row[offset - 1] === "\\") continue;
		spans.push({ from: start, to: offset });
		start = offset + 1;
	}
	spans.push({ from: start, to: row.length });
	// The outer pipes leave empty spans that are not cells.
	const blank = (span: SourceRange) => row.slice(span.from, span.to).trim() === "";
	if (spans.length > 1 && blank(spans[0])) spans.shift();
	if (spans.length > 1 && blank(spans[spans.length - 1])) spans.pop();
	const cell = spans[cellIndex];
	if (!cell) return null;
	let { from, to } = cell;
	while (from < to && /\s/.test(row[from])) from += 1;
	while (to > from && /\s/.test(row[to - 1])) to -= 1;
	return { from, to };
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
		const list = /^[\t ]*(?:[-+*]|\d+[.)])[\t ]+(?:\[[ xX]\][\t ]+)?/.exec(rest);
		if (list) length += list[0].length;
	} else if (/^H[1-6]$/.test(tagName)) {
		const heading = /^[\t ]*#{1,6}[\t ]+/.exec(rest);
		if (heading) length += heading[0].length;
	}
	return length;
}

function words(text: string): string[] {
	return Array.from(
		new Set(text.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 1) ?? []),
	);
}
