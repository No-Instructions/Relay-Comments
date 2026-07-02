import type { CriticMark, CriticMarkType } from "./types";

interface SyntaxDef {
	type: CriticMarkType;
	open: string;
	close: string;
}

const SYNTAX: SyntaxDef[] = [
	{ type: "addition", open: "{++", close: "++}" },
	{ type: "deletion", open: "{--", close: "--}" },
	{ type: "substitution", open: "{~~", close: "~~}" },
	{ type: "comment", open: "{>>", close: "<<}" },
	{ type: "highlight", open: "{==", close: "==}" },
];

const OPENERS = SYNTAX.map((syntax) => syntax.open);
const METADATA_COMMENT_OPEN = "{{";
const METADATA_COMMENT_SEPARATOR = ">>";
const METADATA_COMMENT_CLOSE = "<<}}";

export function parseCriticMarkup(text: string): CriticMark[] {
	const marks: CriticMark[] = [];
	let lineStart = 0;
	let line = 0;

	while (lineStart <= text.length) {
		const nextNewline = text.indexOf("\n", lineStart);
		const lineEnd = nextNewline === -1 ? text.length : nextNewline;
		parseLine(text.slice(lineStart, lineEnd), lineStart, line, marks);
		if (nextNewline === -1) break;
		lineStart = nextNewline + 1;
		line += 1;
	}

	return marks;
}

export function findMarkAtOffset(
	marks: CriticMark[],
	offset: number,
): CriticMark | null {
	return (
		marks.find((mark) => mark.valid && mark.from <= offset && offset <= mark.to) ??
		null
	);
}

export function findFirstMarkInRange(
	marks: CriticMark[],
	from: number,
	to: number,
): CriticMark | null {
	const lo = Math.min(from, to);
	const hi = Math.max(from, to);
	return (
		marks.find((mark) => mark.valid && mark.from <= hi && mark.to >= lo) ??
		null
	);
}

function parseLine(
	lineText: string,
	lineStart: number,
	line: number,
	marks: CriticMark[],
): void {
	let cursor = 0;
	while (cursor < lineText.length) {
		const start = lineText.indexOf("{", cursor);
		if (start === -1) return;

		if (lineText.startsWith(METADATA_COMMENT_OPEN, start)) {
			const mark = parseMetadataComment(lineText, lineStart, line, start);
			if (mark) {
				marks.push(mark);
				cursor = mark.to - lineStart;
			} else {
				cursor = start + METADATA_COMMENT_OPEN.length;
			}
			continue;
		}

		const syntax = SYNTAX.find((candidate) =>
			lineText.startsWith(candidate.open, start),
		);
		if (!syntax) {
			cursor = start + 1;
			continue;
		}

		const contentStart = start + syntax.open.length;
		const closeStart = lineText.indexOf(syntax.close, contentStart);
		if (closeStart === -1) {
			marks.push(
				makeInvalidMark(
					syntax,
					lineText,
					lineStart,
					line,
					start,
					lineText.length,
					"Multiline or unclosed CriticMarkup is not supported yet.",
				),
			);
			return;
		}

		const closeEnd = closeStart + syntax.close.length;
		const absoluteFrom = lineStart + start;
		const absoluteTo = lineStart + closeEnd;
		const raw = lineText.slice(start, closeEnd);
		const rawContent = lineText.slice(contentStart, closeStart);
		const nested = containsNestedCriticMarkup(rawContent);

		if (syntax.type === "substitution") {
			const separator = rawContent.indexOf("~>");
			if (separator === -1) {
				marks.push(
					makeInvalidMark(
						syntax,
						lineText,
						lineStart,
						line,
						start,
						closeEnd,
						"Substitution marks require a ~> separator.",
					),
				);
			} else {
				const oldFrom = lineStart + contentStart;
				const oldTo = oldFrom + separator;
				const separatorFrom = oldTo;
				const separatorTo = separatorFrom + 2;
				const newFrom = separatorTo;
				const newTo = lineStart + closeStart;
				marks.push({
					id: makeMarkId(syntax.type, absoluteFrom, absoluteTo, raw),
					type: syntax.type,
					from: absoluteFrom,
					to: absoluteTo,
					raw,
					content: rawContent,
					oldText: rawContent.slice(0, separator),
					newText: rawContent.slice(separator + 2),
					contentFrom: lineStart + contentStart,
					contentTo: lineStart + closeStart,
					line,
					ranges: {
						opening: [absoluteFrom, lineStart + contentStart],
						oldText: [oldFrom, oldTo],
						separator: [separatorFrom, separatorTo],
						newText: [newFrom, newTo],
						closing: [lineStart + closeStart, absoluteTo],
					},
					valid: !nested,
					error: nested
						? "Nested CriticMarkup is not supported yet."
						: undefined,
				});
			}
		} else {
			marks.push({
				id: makeMarkId(syntax.type, absoluteFrom, absoluteTo, raw),
				type: syntax.type,
				from: absoluteFrom,
				to: absoluteTo,
				raw,
				content: rawContent,
				contentFrom: lineStart + contentStart,
				contentTo: lineStart + closeStart,
				line,
				ranges: {
					opening: [absoluteFrom, lineStart + contentStart],
					closing: [lineStart + closeStart, absoluteTo],
					commentText:
						syntax.type === "comment"
							? [lineStart + contentStart, lineStart + closeStart]
							: undefined,
				},
				valid: !nested,
				error: nested ? "Nested CriticMarkup is not supported yet." : undefined,
			});
		}

		cursor = closeEnd;
	}
}

function parseMetadataComment(
	lineText: string,
	lineStart: number,
	line: number,
	start: number,
): CriticMark | null {
	const metadataStart = start + METADATA_COMMENT_OPEN.length;
	const separatorStart = lineText.indexOf(
		METADATA_COMMENT_SEPARATOR,
		metadataStart,
	);
	if (separatorStart === -1) return null;

	const contentStart = separatorStart + METADATA_COMMENT_SEPARATOR.length;
	const closeStart = lineText.indexOf(METADATA_COMMENT_CLOSE, contentStart);
	if (closeStart === -1) {
		const to = lineText.length;
		const raw = lineText.slice(start, to);
		return {
			id: makeMarkId("comment", lineStart + start, lineStart + to, raw),
			type: "comment",
			from: lineStart + start,
			to: lineStart + to,
			raw,
			content: "",
			contentFrom: lineStart + contentStart,
			contentTo: lineStart + to,
			metadataRaw: lineText.slice(metadataStart, separatorStart),
			metadata: parseMetadata(lineText.slice(metadataStart, separatorStart)),
			line,
			ranges: {},
			valid: false,
			error: "Unclosed metadata CriticMarkup comment.",
		};
	}

	const closeEnd = closeStart + METADATA_COMMENT_CLOSE.length;
	const absoluteFrom = lineStart + start;
	const absoluteTo = lineStart + closeEnd;
	const raw = lineText.slice(start, closeEnd);
	const metadataRaw = lineText.slice(metadataStart, separatorStart);
	const content = lineText.slice(contentStart, closeStart);
	const nested = containsNestedCriticMarkup(content);

	return {
		id: makeMarkId("comment", absoluteFrom, absoluteTo, raw),
		type: "comment",
		from: absoluteFrom,
		to: absoluteTo,
		raw,
		content,
		contentFrom: lineStart + contentStart,
		contentTo: lineStart + closeStart,
		metadataRaw,
		metadata: parseMetadata(metadataRaw),
		line,
		ranges: {
			opening: [absoluteFrom, lineStart + contentStart],
			closing: [lineStart + closeStart, absoluteTo],
			commentText: [lineStart + contentStart, lineStart + closeStart],
		},
		valid: !nested,
		error: nested ? "Nested CriticMarkup is not supported yet." : undefined,
	};
}

function makeInvalidMark(
	syntax: SyntaxDef,
	lineText: string,
	lineStart: number,
	line: number,
	from: number,
	to: number,
	error: string,
): CriticMark {
	const raw = lineText.slice(from, to);
	return {
		id: makeMarkId(syntax.type, lineStart + from, lineStart + to, raw),
		type: syntax.type,
		from: lineStart + from,
		to: lineStart + to,
		raw,
		content: "",
		contentFrom: lineStart + from + syntax.open.length,
		contentTo: lineStart + to,
		line,
		ranges: {},
		valid: false,
		error,
	};
}

function containsNestedCriticMarkup(content: string): boolean {
	return OPENERS.some((opener) => content.includes(opener));
}

function parseMetadata(raw: string): Record<string, string> {
	const metadata: Record<string, string> = {};
	const pattern = /([A-Za-z_][A-Za-z0-9_-]*)="([^"]*)"/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(raw)) !== null) {
		metadata[match[1]] = match[2];
	}
	return metadata;
}

function makeMarkId(
	type: CriticMarkType,
	from: number,
	to: number,
	raw: string,
): string {
	return `${type}:${from}:${to}:${hashString(raw)}`;
}

function hashString(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}
