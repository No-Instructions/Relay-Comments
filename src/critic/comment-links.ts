/**
 * Comment bodies are plain text with two kinds of links people actually
 * write: [[wikilinks]] (with optional |alias and #subpath) and web links —
 * bare http(s) URLs or [label](url) markdown links. This parser splits a
 * body into verbatim segments so every render surface (sidebar, canvas
 * card, hover popover) linkifies the same way. It is not a markdown
 * parser: anything that is not one of those three link shapes stays text,
 * character for character.
 */

export type CommentLinkSegment =
	| { kind: "text"; text: string }
	| { kind: "wikilink"; target: string; display: string }
	| { kind: "weblink"; href: string; display: string };

interface LinkMatch {
	from: number;
	to: number;
	segment: CommentLinkSegment;
}

const WEB_LINK_PATTERN = /https?:\/\/[^\s]+/gi;

/** Punctuation that reads as prose trailing a URL, never part of it. */
const TRAILING_PUNCTUATION = new Set([
	".",
	",",
	";",
	":",
	"!",
	"?",
	"…",
	"'",
	'"',
	"`",
	"<",
	">",
]);

const BRACKET_PAIRS: Record<string, string> = {
	")": "(",
	"]": "[",
	"}": "{",
};

const FINDERS = [findWikilink, findMarkdownLink, findWebLink];

export function parseCommentLinks(text: string): CommentLinkSegment[] {
	const segments: CommentLinkSegment[] = [];
	// Cache each finder's next match across the scan: a match ahead of the
	// cursor stays valid, and an exhausted finder (null) stays exhausted.
	// Without this, every emitted segment re-walks the rest of the text
	// per finder — quadratic on link-heavy bodies, and the sidebar re-runs
	// this on every re-render.
	const next: Array<LinkMatch | null | undefined> = FINDERS.map(
		() => undefined,
	);
	let index = 0;
	while (index < text.length) {
		let best: LinkMatch | null = null;
		for (let i = 0; i < FINDERS.length; i += 1) {
			let candidate = next[i];
			if (candidate === undefined || (candidate && candidate.from < index)) {
				candidate = FINDERS[i](text, index);
				next[i] = candidate;
			}
			// Earliest match wins; ties ([[ vs [) go to the earlier finder —
			// the wikilink.
			if (candidate && (!best || candidate.from < best.from)) {
				best = candidate;
			}
		}
		if (!best) break;
		if (best.from > index) {
			segments.push({ kind: "text", text: text.slice(index, best.from) });
		}
		segments.push(best.segment);
		index = best.to;
	}
	if (index < text.length) {
		segments.push({ kind: "text", text: text.slice(index) });
	}
	return segments;
}

function findWikilink(text: string, from: number): LinkMatch | null {
	let start = text.indexOf("[[", from);
	while (start !== -1) {
		const close = text.indexOf("]]", start + 2);
		if (close === -1) return null;
		const inner = text.slice(start + 2, close);
		// A nested opener means this `[[` never closes; the inner one might.
		const nested = inner.lastIndexOf("[[");
		if (nested !== -1) {
			start += nested + 2;
			continue;
		}
		if (!inner.includes("\n")) {
			const pipe = inner.indexOf("|");
			const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
			const alias = pipe === -1 ? "" : inner.slice(pipe + 1).trim();
			const display = alias.length > 0 ? alias : target;
			// Brackets cannot appear in note names; a target carrying one is
			// a stray bracket riding the delimiter ("[[[Alpha]]]" is
			// "[" + [[Alpha]] + "]"), which the restart below recovers.
			if (
				target.length > 0 &&
				display.length > 0 &&
				!/[[\]]/.test(target)
			) {
				return {
					from: start,
					to: close + 2,
					segment: { kind: "wikilink", target, display },
				};
			}
		}
		// Not a link; the next candidate may start inside this one's
		// delimiters ("[[[" hides a valid opener one character in).
		start = text.indexOf("[[", start + 1);
	}
	return null;
}

function findMarkdownLink(text: string, from: number): LinkMatch | null {
	let start = text.indexOf("[", from);
	while (start !== -1) {
		const labelClose = text.indexOf("]", start + 1);
		if (labelClose === -1) return null;
		const label = text.slice(start + 1, labelClose);
		const urlClose =
			text[labelClose + 1] === "("
				? findBalancedParenClose(text, labelClose + 1)
				: -1;
		if (
			urlClose !== -1 &&
			label.length > 0 &&
			!label.includes("[") &&
			!label.includes("\n")
		) {
			const url = text.slice(labelClose + 2, urlClose);
			if (/^https?:\/\/\S+$/i.test(url)) {
				return {
					from: start,
					to: urlClose + 1,
					segment: { kind: "weblink", href: url, display: label },
				};
			}
		}
		start = text.indexOf("[", start + 1);
	}
	return null;
}

/** Index of the `)` closing the paren at `open`, or -1; nesting counts. */
function findBalancedParenClose(text: string, open: number): number {
	let depth = 0;
	for (let index = open; index < text.length; index += 1) {
		const char = text[index];
		if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) return index;
		} else if (char === "\n") return -1;
	}
	return -1;
}

function findWebLink(text: string, from: number): LinkMatch | null {
	WEB_LINK_PATTERN.lastIndex = from;
	let match: RegExpExecArray | null;
	while ((match = WEB_LINK_PATTERN.exec(text))) {
		let raw = match[0];
		// A wikilink glued to the URL is a link boundary, not URL content —
		// its balanced brackets would survive the punctuation trim.
		const wikiAt = raw.indexOf("[[");
		if (wikiAt !== -1) raw = raw.slice(0, wikiAt);
		const url = trimTrailingPunctuation(raw);
		// A bare scheme ("https:// …" mid-sentence) is prose, not a link.
		if (!/^https?:\/\/$/i.test(url)) {
			return {
				from: match.index,
				to: match.index + url.length,
				segment: { kind: "weblink", href: url, display: url },
			};
		}
		WEB_LINK_PATTERN.lastIndex = match.index + match[0].length;
	}
	return null;
}

/**
 * Strip prose punctuation from the end of a liberal URL match: `see
 * https://a.io.` keeps the dot out, while a closing bracket survives only
 * when the URL itself opened it (Wikipedia-style `..._(disambiguation)`).
 */
function trimTrailingPunctuation(url: string): string {
	let end = url.length;
	while (end > 0) {
		const char = url[end - 1];
		if (TRAILING_PUNCTUATION.has(char)) {
			end -= 1;
			continue;
		}
		const opener = BRACKET_PAIRS[char];
		if (opener) {
			const slice = url.slice(0, end);
			const opened = slice.split(opener).length - 1;
			const closed = slice.split(char).length - 1;
			if (closed > opened) {
				end -= 1;
				continue;
			}
		}
		break;
	}
	return url.slice(0, end);
}
