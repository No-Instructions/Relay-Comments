import type { CriticMark } from "./types";

/**
 * The text Live Preview shows for one line of Markdown, with the source offset of each
 * shown character. `opaque` holds source offsets an anchor may not cover: hidden structure
 * such as a link destination, and shown text inside links and code spans, where inserted
 * markup would not render. Hidden emphasis markers and escapes are not opaque.
 */
export interface VisibleText {
	text: string;
	offsets: number[];
	opaque: Set<number>;
}

const EMBED = /^!\[\[[^\]\n]*\]\]|^!\[[^\]\n]*\]\([^)\n]*\)/;
const WIKILINK = /^\[\[([^\]|\n]*)(?:\|([^\]\n]*))?\]\]/;
const LINK = /^\[([^\]\n]*)\]\([^)\n]*\)/;
const HIDDEN_SPAN = /^<\/?[A-Za-z][^>\n]*>|^%%.*?%%/;
const ESCAPABLE = /[!-/:-@[-`{-~]/;

function criticSyntax(marks: Iterable<CriticMark>): Set<number> {
	const hidden = new Set<number>();
	const add = (range?: [number, number]): void => {
		if (range) for (let i = range[0]; i < range[1]; i += 1) hidden.add(i);
	};
	for (const mark of marks) {
		if (mark.type === "comment") {
			add([mark.from, mark.to]);
		} else {
			add(mark.ranges.opening);
			add(mark.ranges.separator);
			add(mark.ranges.closing);
		}
	}
	return hidden;
}

/** Scan `text` from `from` to `to`. Unrecognized syntax counts as shown. */
export function visibleText(
	text: string,
	from: number,
	to: number,
	marks: Iterable<CriticMark>,
): VisibleText {
	const result: VisibleText = { text: "", offsets: [], opaque: new Set() };
	const critic = criticSyntax(marks);
	const show = (start: number, end: number): void => {
		for (let i = start; i < end; i += 1) {
			result.text += text[i];
			result.offsets.push(i);
		}
	};
	const seal = (start: number, end: number): void => {
		for (let i = start; i < end; i += 1) result.opaque.add(i);
	};
	const isWord = (i: number): boolean => i >= from && i < to && /\w/.test(text[i]);

	let i = from;
	while (i < to) {
		const rest = text.slice(i, to);
		if (critic.has(i)) {
			seal(i, i + 1);
			i += 1;
			continue;
		}

		const opaque = EMBED.exec(rest) ?? HIDDEN_SPAN.exec(rest);
		if (opaque) {
			seal(i, i + opaque[0].length);
			i += opaque[0].length;
			continue;
		}

		const wikilink = WIKILINK.exec(rest);
		if (wikilink) {
			const end = i + wikilink[0].length;
			const labelFrom = wikilink[2] === undefined ? i + 2 : end - 2 - wikilink[2].length;
			show(labelFrom, end - 2);
			seal(i, end);
			i = end;
			continue;
		}

		const link = LINK.exec(rest);
		if (link) {
			const end = i + link[0].length;
			show(i + 1, i + 1 + link[1].length);
			seal(i, end);
			i = end;
			continue;
		}

		const ticks = /^`+/.exec(rest)?.[0];
		if (ticks) {
			const close = text.indexOf(ticks, i + ticks.length);
			if (close >= 0 && close < to) {
				show(i + ticks.length, close);
				seal(i + ticks.length, close);
				i = close + ticks.length;
				continue;
			}
		}

		if (text[i] === "\\" && i + 1 < to && ESCAPABLE.test(text[i + 1])) {
			show(i + 1, i + 2);
			i += 2;
			continue;
		}

		const pair = /^(?:~~|==)/.exec(rest);
		if (pair || text[i] === "*" || (text[i] === "_" && !(isWord(i - 1) && isWord(i + 1)))) {
			i += pair ? 2 : 1;
			continue;
		}

		show(i, i + 1);
		i += 1;
	}
	return result;
}
