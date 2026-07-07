import type { CriticMark } from "../critic/types";

export interface CriticTaskPrefix {
	lineFrom: number;
	markerFrom: number;
	markerTo: number;
	checkboxFrom: number;
	checkboxTo: number;
	bodyFrom: number;
	checked: boolean;
	task: string;
	/** Whitespace before the list bullet, mark delimiters excluded —
	    drives the same list-nesting classes Obsidian gives real tasks. */
	indent: string;
}

const LEADING_WHITESPACE = /^[\t ]*$/;
const TASK_PREFIX = /^([\t ]*)(?:[-*+]|\d+[.)])[\t ]+\[([ xX])\]([\t ]+|$)/;

/**
 * Detect Markdown task markers that were included inside a CriticMarkup mark
 * at the start of source lines, e.g. `{==- [ ] Ship==}`.
 */
export function findCriticTaskPrefixes(
	text: string,
	mark: CriticMark,
): CriticTaskPrefix[] {
	if (
		!mark.valid ||
		!(
			mark.type === "addition" ||
			mark.type === "deletion" ||
			mark.type === "highlight"
		)
	) {
		return [];
	}

	const prefixes: CriticTaskPrefix[] = [];
	let lineFrom = text.lastIndexOf("\n", Math.max(0, mark.contentFrom - 1)) + 1;
	let segmentFrom = mark.contentFrom;

	while (segmentFrom < mark.contentTo) {
		const lineEnd = findLineEnd(text, segmentFrom, mark.contentTo);
		const isOpeningLine = segmentFrom === mark.contentFrom;
		if (
			!isOpeningLine ||
			LEADING_WHITESPACE.test(text.slice(lineFrom, mark.from))
		) {
			const line = text.slice(segmentFrom, lineEnd);
			const match = TASK_PREFIX.exec(line);
			if (match) {
				const leading = match[1].length;
				const bracket = match[0].indexOf("[", leading);
				const checkboxFrom = segmentFrom + bracket + 1;
				const task = match[2].toLowerCase() === "x" ? "x" : " ";
				prefixes.push({
					lineFrom,
					markerFrom: segmentFrom + leading,
					markerTo: segmentFrom + match[0].length,
					checkboxFrom,
					checkboxTo: checkboxFrom + 1,
					bodyFrom: segmentFrom + match[0].length,
					checked: task === "x",
					task,
					indent: isOpeningLine
						? text.slice(lineFrom, mark.from) + match[1]
						: match[1],
				});
			}
		}
		if (lineEnd >= mark.contentTo) break;
		lineFrom = lineEnd + 1;
		segmentFrom = lineFrom;
	}

	return prefixes;
}

export function findCriticTaskPrefix(
	text: string,
	mark: CriticMark,
): CriticTaskPrefix | null {
	return findCriticTaskPrefixes(text, mark)[0] ?? null;
}

function findLineEnd(text: string, from: number, limit: number): number {
	const nextNewline = text.indexOf("\n", from);
	return nextNewline === -1 || nextNewline > limit ? limit : nextNewline;
}
