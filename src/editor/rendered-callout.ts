import { structuralPrefixLength, type AnchorRange } from "../critic/anchor-range";
import { parseCriticMarkup } from "../critic/parse";
import { visibleText } from "../critic/visible-text";

const CALLOUT_SELECTOR = ".cm-embed-block.cm-callout";
const SECTION_SELECTOR = ".callout-title-inner, .callout-content";
const ELEMENT_NODE = 1;

export type CalloutSection = "title" | "body";

/** Content ranges, after quote and callout syntax, of the blockquote starting at `blockFrom`. */
function calloutLines(text: string, blockFrom: number): AnchorRange[] {
	const lines: AnchorRange[] = [];
	let lineFrom = blockFrom;
	for (;;) {
		const newline = text.indexOf("\n", lineFrom);
		const line = text.slice(lineFrom, newline < 0 ? text.length : newline).replace(/\r$/, "");
		if (!/^[ \t]*>/.test(line)) break;
		lines.push({ from: lineFrom + structuralPrefixLength(line), to: lineFrom + line.length });
		if (newline < 0) break;
		lineFrom = newline + 1;
	}
	return lines;
}

/**
 * Source range of `selected`, which starts at `selectionStart` within the rendered text
 * of one section of the callout whose first line starts at `blockFrom`. The section's
 * visible source text must equal the rendered text apart from whitespace, so the
 * selection maps by position; content the source scan does not model (an embed, an
 * entity, a generated title) makes the texts differ and returns null. The match may not
 * span hidden structure such as a link destination, or a line break.
 */
export function locateRenderedCalloutText(
	text: string,
	blockFrom: number,
	section: CalloutSection,
	renderedSection: string,
	selectionStart: number,
	selected: string,
): AnchorRange | null {
	if (
		!selected.trim() ||
		selected.includes("\n") ||
		renderedSection.slice(selectionStart, selectionStart + selected.length) !== selected
	) {
		return null;
	}

	const lines = calloutLines(text, blockFrom);
	const marks = parseCriticMarkup(text);
	const shown: number[] = [];
	const opaque = new Set<number>();
	for (const line of section === "title" ? lines.slice(0, 1) : lines.slice(1)) {
		const visible = visibleText(text, line.from, line.to, marks);
		for (let i = 0; i < visible.text.length; i += 1) {
			if (!/\s/.test(visible.text[i])) shown.push(visible.offsets[i]);
		}
		visible.opaque.forEach((offset) => opaque.add(offset));
	}
	const squeeze = (value: string): string => value.replace(/\s+/g, "");
	if (shown.map((offset) => text[offset]).join("") !== squeeze(renderedSection)) return null;

	const first = squeeze(renderedSection.slice(0, selectionStart)).length;
	const from = shown[first];
	const to = shown[first + squeeze(selected).length - 1] + 1;
	if (text.slice(from, to).includes("\n")) return null;

	for (let i = from; i < to; i += 1) {
		if (opaque.has(i)) return null;
	}
	return { from, to };
}

/** The slice of a CodeMirror view this reads. */
export interface CalloutSelectionView {
	contentDOM: HTMLElement;
	state: { doc: { toString(): string; lineAt(pos: number): { from: number } } };
	posAtDOM(node: Node, offset?: number): number;
}

function elementOf(node: Node): Element | null {
	return node.nodeType === ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/**
 * Source range for a DOM selection held inside one section (title or body) of a rendered
 * Live Preview callout, or null when the selection is elsewhere, spans sections or a
 * nested callout, or cannot be placed exactly in the source.
 */
export function renderedCalloutSelection(view: CalloutSelectionView): AnchorRange | null {
	const selection = view.contentDOM.ownerDocument.getSelection();
	if (!selection || selection.rangeCount === 0) return null;

	const range = selection.getRangeAt(0);
	const section = elementOf(range.startContainer)?.closest(SECTION_SELECTOR);
	const callout = section?.closest(CALLOUT_SELECTOR);
	if (
		!section ||
		!callout ||
		!view.contentDOM.contains(callout) ||
		elementOf(range.endContainer)?.closest(SECTION_SELECTOR) !== section ||
		section.closest(".callout") !== callout.querySelector(".callout")
	) {
		return null;
	}

	const raw = range.toString();
	const selected = raw.trim();
	if (!selected) return null;

	const before = callout.ownerDocument.createRange();
	before.selectNodeContents(section);
	before.setEnd(range.startContainer, range.startOffset);
	return locateRenderedCalloutText(
		view.state.doc.toString(),
		view.state.doc.lineAt(view.posAtDOM(callout)).from,
		section.matches(".callout-title-inner") ? "title" : "body",
		section.textContent ?? "",
		before.toString().length + raw.length - raw.trimStart().length,
		selected,
	);
}
