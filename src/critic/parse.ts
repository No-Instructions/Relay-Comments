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
	const lineAt = createLineTracker(text);
	let cursor = 0;

	while (cursor < text.length) {
		const start = text.indexOf("{", cursor);
		if (start === -1) break;

		if (text.startsWith(METADATA_COMMENT_OPEN, start)) {
			const mark = parseMetadataComment(text, start, lineAt);
			if (mark) {
				marks.push(mark);
				cursor = mark.to;
			} else {
				// Not a metadata comment; the next char may still open a
				// standard mark ("{{++…"), so only skip one character.
				cursor = start + 1;
			}
			continue;
		}

		const syntax = SYNTAX.find((candidate) =>
			text.startsWith(candidate.open, start),
		);
		if (!syntax) {
			cursor = start + 1;
			continue;
		}

		const contentStart = start + syntax.open.length;
		const closeStart = text.indexOf(syntax.close, contentStart);
		if (closeStart === -1) {
			// Unclosed marker (often mid-typing). Flag only its own line so we
			// never swallow the rest of the document.
			const lineEnd = endOfLine(text, start);
			marks.push(
				makeInvalidMark(
					syntax.type,
					text,
					start,
					lineEnd,
					contentStart,
					"Unclosed CriticMarkup mark.",
					lineAt(start),
				),
			);
			cursor = lineEnd;
			continue;
		}

		const closeEnd = closeStart + syntax.close.length;
		const raw = text.slice(start, closeEnd);
		const rawContent = text.slice(contentStart, closeStart);
		const nested = containsNestedCriticMarkup(rawContent);
		const line = lineAt(start);

		if (syntax.type === "substitution") {
			const separator = rawContent.indexOf("~>");
			if (separator === -1) {
				marks.push(
					makeInvalidMark(
						syntax.type,
						text,
						start,
						closeEnd,
						contentStart,
						"Substitution marks require a ~> separator.",
						line,
					),
				);
			} else {
				const oldFrom = contentStart;
				const oldTo = oldFrom + separator;
				const separatorTo = oldTo + 2;
				marks.push({
					id: makeMarkId(syntax.type, start, closeEnd, raw),
					type: syntax.type,
					from: start,
					to: closeEnd,
					raw,
					content: rawContent,
					oldText: rawContent.slice(0, separator),
					newText: rawContent.slice(separator + 2),
					contentFrom: contentStart,
					contentTo: closeStart,
					line,
					ranges: {
						opening: [start, contentStart],
						oldText: [oldFrom, oldTo],
						separator: [oldTo, separatorTo],
						newText: [separatorTo, closeStart],
						closing: [closeStart, closeEnd],
					},
					valid: !nested,
					error: nested
						? "Nested CriticMarkup is not supported yet."
						: undefined,
				});
			}
		} else {
			marks.push({
				id: makeMarkId(syntax.type, start, closeEnd, raw),
				type: syntax.type,
				from: start,
				to: closeEnd,
				raw,
				content: rawContent,
				contentFrom: contentStart,
				contentTo: closeStart,
				line,
				ranges: {
					opening: [start, contentStart],
					closing: [closeStart, closeEnd],
					commentText:
						syntax.type === "comment"
							? [contentStart, closeStart]
							: undefined,
				},
				valid: !nested,
				error: nested ? "Nested CriticMarkup is not supported yet." : undefined,
			});
		}

		cursor = closeEnd;
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

function parseMetadataComment(
	text: string,
	start: number,
	lineAt: (offset: number) => number,
): CriticMark | null {
	const metadataStart = start + METADATA_COMMENT_OPEN.length;
	// The metadata section must stay on the opening line; otherwise any "{{"
	// would greedily pair with a ">>" much later in the document.
	const openLineEnd = endOfLine(text, start);
	const separatorStart = text.indexOf(METADATA_COMMENT_SEPARATOR, metadataStart);
	if (separatorStart === -1 || separatorStart >= openLineEnd) return null;

	const contentStart = separatorStart + METADATA_COMMENT_SEPARATOR.length;
	const metadataRaw = text.slice(metadataStart, separatorStart);
	const line = lineAt(start);
	const closeStart = text.indexOf(METADATA_COMMENT_CLOSE, contentStart);
	if (closeStart === -1) {
		const to = openLineEnd;
		const raw = text.slice(start, to);
		return {
			id: makeMarkId("comment", start, to, raw),
			type: "comment",
			from: start,
			to,
			raw,
			content: "",
			contentFrom: contentStart,
			contentTo: to,
			metadataRaw,
			metadata: parseMetadata(metadataRaw),
			line,
			ranges: {},
			valid: false,
			error: "Unclosed metadata CriticMarkup comment.",
		};
	}

	const closeEnd = closeStart + METADATA_COMMENT_CLOSE.length;
	const raw = text.slice(start, closeEnd);
	const content = text.slice(contentStart, closeStart);
	const nested = containsNestedCriticMarkup(content);

	return {
		id: makeMarkId("comment", start, closeEnd, raw),
		type: "comment",
		from: start,
		to: closeEnd,
		raw,
		content,
		contentFrom: contentStart,
		contentTo: closeStart,
		metadataRaw,
		metadata: parseMetadata(metadataRaw),
		line,
		ranges: {
			opening: [start, contentStart],
			closing: [closeStart, closeEnd],
			commentText: [contentStart, closeStart],
		},
		valid: !nested,
		error: nested ? "Nested CriticMarkup is not supported yet." : undefined,
	};
}

function makeInvalidMark(
	type: CriticMarkType,
	text: string,
	from: number,
	to: number,
	contentFrom: number,
	error: string,
	line: number,
): CriticMark {
	const raw = text.slice(from, to);
	return {
		id: makeMarkId(type, from, to, raw),
		type,
		from,
		to,
		raw,
		content: "",
		contentFrom,
		contentTo: to,
		line,
		ranges: {},
		valid: false,
		error,
	};
}

function endOfLine(text: string, offset: number): number {
	const nextNewline = text.indexOf("\n", offset);
	return nextNewline === -1 ? text.length : nextNewline;
}

function createLineTracker(text: string): (offset: number) => number {
	let scanned = 0;
	let line = 0;
	return (offset: number): number => {
		if (offset < scanned) {
			scanned = 0;
			line = 0;
		}
		while (scanned < offset) {
			const nextNewline = text.indexOf("\n", scanned);
			if (nextNewline === -1 || nextNewline >= offset) break;
			line += 1;
			scanned = nextNewline + 1;
		}
		scanned = offset;
		return line;
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
