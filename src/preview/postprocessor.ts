import {
	type MarkdownPostProcessorContext,
	type MarkdownSectionInformation,
} from "obsidian";
import { parseCriticMarkup } from "../critic/parse";
import { renderDisplaySegments, renderSliceSegments } from "../critic/render";
import type { CriticMark, DisplayMode, RenderSegment } from "../critic/types";
import {
	commentFootnoteOrdinals,
	isCommentOnlySection,
	renderedElementSourceRange,
	sectionSourceRange,
} from "./sections";
import { highlightColorClass } from "../markdown/highlights";
import { previewCommentComponents } from "./comment-components";
import {
	marksIntact,
	matchRenderedAnchor,
	repairMangledMarks,
	runsTouching,
} from "./blocks";

export interface PreviewDisplayController {
	getDisplayMode(path?: string | null): DisplayMode;
	notifyRenderedCommentsChanged?(): void;
}

const SKIP_TAGS = new Set([
	"CODE",
	"PRE",
	"SCRIPT",
	"STYLE",
	"TEXTAREA",
	"MATH",
]);
const SOURCE_PATTERN = /\{(?:\+\+|--|~~|>>|==)|\{\{[^\n}]*>>/;
const DOM_REMNANT_PATTERN = /[{}]|~>|<<|>>|\+\+|--|==|~~/;
const SOURCE_RENDER_TAGS = [
	"p",
	"li",
	"blockquote",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"td",
	"th",
];
const SOURCE_RENDER_SELECTOR = SOURCE_RENDER_TAGS.join(", ");
const EMBEDDED_SOURCE_RENDER_SELECTOR = SOURCE_RENDER_TAGS.map(
	(tag) => `.cm-embed-block ${tag}`,
).join(", ");
let previewTargetSequence = 0;

/**
 * Finish CriticMarkup inside the blocks Obsidian embeds in Live Preview (tables,
 * callouts): repair what its renderer mangled, render in place when the marks are
 * intact and from source otherwise, then give the highlights anchor identity.
 */
export function rewriteCriticMarkupInRenderedBlocks(
	root: HTMLElement,
	text: string,
	mode: DisplayMode,
	marks: readonly CriticMark[],
): void {
	const validMarks = marks.filter((mark) => mark.valid);
	if (validMarks.length === 0) return;

	const candidates = Array.from(
		root.querySelectorAll<HTMLElement>(EMBEDDED_SOURCE_RENDER_SELECTOR),
	);
	for (const candidate of candidates) {
		if (shouldSkip(candidate)) continue;
		const target = renderTarget(candidate);
		repairMangledMarks(target);
		const remnants = DOM_REMNANT_PATTERN.test(target.textContent ?? "");
		const unannotated = target.querySelector(
			".critic-preview-highlight:not([data-critic-from])",
		);
		if (!remnants && !unannotated) continue;

		const range = matchSourceLineRange(candidate, text);
		if (!range) continue;
		const sliceMarks = validMarks.filter(
			(mark) => mark.from < range.to && mark.to > range.from,
		);
		if (sliceMarks.length === 0) continue;

		if (remnants) {
			if (marksIntact(textNodeValues(target), sliceMarks)) {
				renderTextNodes(target, mode);
			} else if (
				elementCoversSource(candidate, text.slice(range.from, range.to))
			) {
				rewriteElementFromSourceRange(target, text, range, mode);
			} else {
				continue;
			}
		}
		annotateRenderedAnchors(target, text, range, validMarks);
	}
}

/** Give a block's highlights the run range and anchor class the editor handlers look for. */
function annotateRenderedAnchors(
	el: HTMLElement,
	text: string,
	range: { from: number; to: number },
	marks: readonly CriticMark[],
): void {
	const highlights = Array.from(
		el.querySelectorAll<HTMLElement>(
			".critic-preview-highlight:not([data-critic-from])",
		),
	);
	if (highlights.length === 0) return;
	const runs = runsTouching(text, marks, range.from, range.to);
	for (const highlight of highlights) {
		const match = matchRenderedAnchor(
			text,
			runs,
			marks,
			highlight.textContent ?? "",
			highlight.getAttribute("title"),
		);
		if (!match) continue;
		highlight.dataset.criticFrom = String(match.from);
		highlight.dataset.criticTo = String(match.to);
		highlight.addClass("cm-critic-thread-anchor");
		highlight.removeAttribute("title");
	}
}

/** Rewrite a cell's wrapper so Live Preview keeps its table chrome. */
function renderTarget(el: HTMLElement): HTMLElement {
	if (el.tagName !== "TD" && el.tagName !== "TH") return el;
	return el.querySelector<HTMLElement>(":scope > .table-cell-wrapper") ?? el;
}

function cellIndexOf(el: HTMLElement): number | undefined {
	if (el.tagName !== "TD" && el.tagName !== "TH") return undefined;
	const index = (el as HTMLTableCellElement).cellIndex;
	return typeof index === "number" && index >= 0 ? index : undefined;
}

export function createReviewPostProcessor(
	controller: PreviewDisplayController,
) {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
		const mode = controller.getDisplayMode(ctx.sourcePath);
		if (hideCommentFootnotes(el, ctx) || hideCommentOnlySection(el, ctx)) {
			appendSectionCommentComponents(el, ctx);
			controller.notifyRenderedCommentsChanged?.();
			return;
		}
		// Put the source text back where Obsidian rendered {==anchor==} as a highlight.
		repairMangledMarks(el);
		rewriteSourceBackedElements(el, ctx, mode);
		renderTextNodes(el, mode);
		appendSectionCommentComponents(el, ctx);
		controller.notifyRenderedCommentsChanged?.();
	};
}

function hideCommentFootnotes(
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
): boolean {
	const footnotes = el.matches("section.footnotes")
		? el
		: el.querySelector<HTMLElement>("section.footnotes");
	if (!footnotes) return false;
	const section = ctx.getSectionInfo(el);
	if (!section) return false;
	const hiddenOrdinals = commentFootnoteOrdinals(section.text);
	if (hiddenOrdinals.size === 0) return false;

	for (const item of Array.from(
		footnotes.querySelectorAll<HTMLElement>("li[data-footnote-id]"),
	)) {
		const id = item.dataset.footnoteId ?? "";
		const ordinal = Number(/^fn-(\d+)(?:-|$)/.exec(id)?.[1]);
		if (hiddenOrdinals.has(ordinal)) item.remove();
	}
	footnotes.addClass("critic-preview-filtered-footnotes");
	if (footnotes.querySelector("li[data-footnote-id]")) return false;
	el.replaceChildren();
	el.addClass("critic-preview-hidden-comment-section");
	return true;
}

function hideCommentOnlySection(
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
): boolean {
	const section = ctx.getSectionInfo(el);
	if (!section || !isCommentOnlySection(section)) return false;
	el.replaceChildren();
	el.addClass("critic-preview-hidden-comment-section");
	return true;
}

function rewriteSourceBackedElements(
	root: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	mode: DisplayMode,
): void {
	const candidates: HTMLElement[] = [];
	if (root.matches(SOURCE_RENDER_SELECTOR)) candidates.push(root);
	candidates.push(
		...Array.from(root.querySelectorAll<HTMLElement>(SOURCE_RENDER_SELECTOR)),
	);

	const rewritten = new Set<HTMLElement>();
	for (const candidate of candidates) {
		if (rewritten.has(candidate) || shouldSkip(candidate)) continue;
		// Section info carries the whole note as `text`; the section is the line range.
		const section = ctx.getSectionInfo(candidate);
		const sectionRange = section ? sectionSourceRange(section) : null;
		if (!section || !sectionRange) continue;
		const sectionText = section.text.slice(sectionRange.from, sectionRange.to);
		if (!SOURCE_PATTERN.test(sectionText)) continue;
		if (rewriteMultilineSlice(candidate, section, mode)) {
			rewritten.add(candidate);
			continue;
		}
		const lineIndex = selectSourceLineForElement(candidate, section, sectionRange);
		if (lineIndex === null) continue;
		const range = renderedElementSourceRange(
			{ text: section.text, lineStart: lineIndex, lineEnd: lineIndex },
			candidate.tagName,
			candidate.textContent ?? "",
			{ cellIndex: cellIndexOf(candidate) },
		);
		if (!range) continue;
		// Intact marks render in place, keeping Obsidian's inline formatting.
		const sliceMarks = marksOf(section.text).filter(
			(mark) => mark.valid && mark.from < range.to && mark.to > range.from,
		);
		if (
			sliceMarks.length > 0 &&
			marksIntact(textNodeValues(candidate), sliceMarks)
		) {
			continue;
		}
		if (rewriteElementFromSourceRange(candidate, section.text, range, mode)) {
			rewritten.add(candidate);
		}
	}
}

const parsedTexts = new Map<string, CriticMark[]>();

/** Parsed marks for a note text, cached across the elements of one render. */
function marksOf(text: string): CriticMark[] {
	const cached = parsedTexts.get(text);
	if (cached) return cached;
	const marks = parseCriticMarkup(text);
	if (parsedTexts.size > 8) parsedTexts.clear();
	parsedTexts.set(text, marks);
	return marks;
}

/** Text node values under an element, skipping code and comment components. */
function textNodeValues(root: HTMLElement): string[] {
	const values: string[] = [];
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			return !parent || shouldSkip(parent)
				? NodeFilter.FILTER_REJECT
				: NodeFilter.FILTER_ACCEPT;
		},
	});
	while (walker.nextNode()) {
		values.push(walker.currentNode.nodeValue ?? "");
	}
	return values;
}

/** Render CriticMarkup found whole inside text nodes, in place. */
function renderTextNodes(root: HTMLElement, mode: DisplayMode): void {
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (!parent || shouldSkip(parent)) return NodeFilter.FILTER_REJECT;
			const text = node.nodeValue ?? "";
			return text.includes("{")
				? NodeFilter.FILTER_ACCEPT
				: NodeFilter.FILTER_SKIP;
		},
	});
	const nodes: Text[] = [];
	while (walker.nextNode()) {
		nodes.push(walker.currentNode as Text);
	}
	for (const node of nodes) {
		replaceTextNode(node, mode);
	}
}

/**
 * Render a section that intersects a mark spanning line breaks. Uses the
 * section's exact offsets in the full note source, so a mark crossing
 * section boundaries renders each of its slices correctly.
 */
function rewriteMultilineSlice(
	el: HTMLElement,
	section: MarkdownSectionInformation,
	mode: DisplayMode,
): boolean {
	const text = section.text;
	const range = renderedElementSourceRange(
		section,
		el.tagName,
		el.textContent ?? "",
	);
	if (!range) return false;
	const { from, to } = range;

	const crossesLines = parseCriticMarkup(text).some(
		(mark) =>
			mark.valid &&
			mark.raw.includes("\n") &&
			mark.from < to &&
			mark.to > from,
	);
	if (!crossesLines) return false;
	if (!elementCoversSource(el, text.slice(from, to))) return false;

	const segments = renderSliceSegments(text, from, to, mode);
	if (segments.length === 1 && segments[0].kind === "text") return false;

	const fragment = createFragment();
	for (const segment of segments) {
		appendSegment(fragment, segment);
	}
	el.replaceChildren(fragment);
	el.addClass("critic-preview-source-rendered");
	return true;
}

/** The note line, within the element's section, whose words best match it. */
function selectSourceLineForElement(
	el: HTMLElement,
	section: MarkdownSectionInformation,
	sectionRange: { from: number; to: number },
): number | null {
	const domText = el.textContent ?? "";
	if (!DOM_REMNANT_PATTERN.test(domText)) return null;

	const lines = section.text.split("\n");
	const candidates: Array<{ line: string; index: number }> = [];
	for (
		let index = section.lineStart;
		index <= Math.min(section.lineEnd, lines.length - 1);
		index += 1
	) {
		const line = lines[index].trimEnd();
		if (SOURCE_PATTERN.test(line)) candidates.push({ line, index });
	}
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0].index;

	// Marks spanning line breaks cannot be reconstructed line by line; the
	// slice-based path handles paragraphs, and other blocks are left with
	// visible source rather than risking corruption.
	if (
		parseCriticMarkup(section.text).some(
			(mark) =>
				mark.valid &&
				mark.raw.includes("\n") &&
				mark.from < sectionRange.to &&
				mark.to > sectionRange.from,
		)
	) {
		return null;
	}

	const domWords = words(domText);
	let best: number | null = null;
	let bestScore = 0;
	for (const { line, index } of candidates) {
		const normalizedLine = normalizeSectionText(el, line);
		const searchText = `${line} ${getRenderedSearchText(normalizedLine)}`;
		const sourceWords = words(searchText);
		const score = sourceWords.filter((word) => domWords.includes(word)).length;
		if (score > bestScore) {
			best = index;
			bestScore = score;
		}
	}
	return bestScore > 0 ? best : null;
}

function matchSourceLineRange(
	el: HTMLElement,
	text: string,
): { from: number; to: number } | null {
	const domText = el.textContent ?? "";
	const domWords = words(domText);
	if (domWords.length === 0) return null;

	const lines = text.split("\n");
	let bestLine = -1;
	let bestScore = 0;
	for (let line = 0; line < lines.length; line += 1) {
		if (!SOURCE_PATTERN.test(lines[line])) continue;
		const sourceWords = words(lines[line]);
		const score = sourceWords.filter((word) => domWords.includes(word)).length;
		if (score > bestScore) {
			bestLine = line;
			bestScore = score;
		}
	}
	if (bestLine < 0) return null;
	return renderedElementSourceRange(
		{ text, lineStart: bestLine, lineEnd: bestLine },
		el.tagName,
		domText,
		{ cellIndex: cellIndexOf(el) },
	);
}

/**
 * Whether this element is the one the source slice produced, by word overlap.
 * Only the source's visible words count: comment bodies never render into it.
 */
function elementCoversSource(el: HTMLElement, source: string): boolean {
	const domWords = words(el.textContent ?? "");
	const visibleWords = words(getRenderedVisibleText(source));
	const sourceWords = words(`${source} ${getRenderedSearchText(source)}`);
	if (domWords.length === 0 || visibleWords.length === 0) return false;
	const domInSource =
		domWords.filter((word) => sourceWords.includes(word)).length /
		domWords.length;
	const visibleInDom =
		visibleWords.filter((word) => domWords.includes(word)).length /
		visibleWords.length;
	return domInSource >= 0.7 && visibleInDom >= 0.7;
}

function getRenderedSearchText(source: string): string {
	return renderDisplaySegments(source, "review")
		.map((segment) => `${segment.text} ${segment.title ?? ""}`)
		.join(" ");
}

function getRenderedVisibleText(source: string): string {
	return renderDisplaySegments(source, "review")
		.map((segment) => segment.text)
		.join(" ");
}

function words(text: string): string[] {
	return Array.from(
		new Set(text.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 1) ?? []),
	);
}

/** Source text as the reader sees it, for matching against rendered words. */
function normalizeSectionText(el: HTMLElement, source: string): string {
	const tag = el.tagName;
	const unquoted = source
		.split("\n")
		.map((line) => line.replace(/^(?:[\t ]*>[\t ]?)+/, ""))
		.join("\n");
	if (/^H[1-6]$/.test(tag)) {
		return unquoted.replace(/^#{1,6}\s+/, "");
	}
	if (tag === "LI") {
		return unquoted.replace(/^(\s*)(?:[-*+]|\d+[.)])\s+/, "$1");
	}
	return unquoted;
}

/** Render a slice of the note into the element; false when it holds no markup. */
function rewriteElementFromSourceRange(
	el: HTMLElement,
	text: string,
	range: { from: number; to: number },
	mode: DisplayMode,
): boolean {
	const segments = renderSliceSegments(text, range.from, range.to, mode);
	if (segments.length === 1 && segments[0].kind === "text") return false;
	const fragment = createFragment();
	for (const segment of segments) {
		appendSegment(fragment, segment);
	}
	el.replaceChildren(fragment);
	el.addClass("critic-preview-source-rendered");
	return true;
}

function shouldSkip(el: HTMLElement): boolean {
	// A cell being edited hosts its own CodeMirror view.
	if (el.querySelector(".cm-editor")) return true;
	let current: HTMLElement | null = el;
	while (current) {
		if (
			SKIP_TAGS.has(current.tagName) ||
			current.matches(
				".critic-preview-filtered-footnotes, .critic-preview-comment-component",
			)
		) {
			return true;
		}
		current = current.parentElement;
	}
	return false;
}

function replaceTextNode(node: Text, mode: DisplayMode): void {
	const text = node.nodeValue ?? "";
	const segments = renderDisplaySegments(text, mode);
	if (segments.length === 1 && segments[0].kind === "text") return;

	const fragment = createFragment();
	for (const segment of segments) {
		appendSegment(fragment, segment);
	}
	node.replaceWith(fragment);
}

function appendSectionCommentComponents(
	host: HTMLElement,
	ctx: MarkdownPostProcessorContext,
): void {
	const section = ctx.getSectionInfo(host);
	const range = section ? sectionSourceRange(section) : null;
	if (!section || !range) return;
	const comments = previewCommentComponents(section.text, range);
	if (comments.length === 0) return;
	const targetId =
		host.id || `critic-preview-comment-target-${++previewTargetSequence}`;
	if (!host.id) host.id = targetId;
	for (const comment of comments) {
		const component = host.createSpan({
			cls: "critic-preview-comment-component",
			attr: {
				"data-criticmarkup-comment": "v1",
				"data-criticmarkup-status": comment.status,
				"data-criticmarkup-thread": `${ctx.sourcePath}:${comment.thread}`,
				"data-criticmarkup-key": `${ctx.sourcePath}:${comment.key}`,
				"data-criticmarkup-target": targetId,
				"data-criticmarkup-label": ctx.sourcePath,
				...(comment.author
					? { "data-criticmarkup-author": comment.author }
					: {}),
			},
		});
		component.createSpan({
			attr: { "data-criticmarkup-body": "" },
			text: comment.body,
		});
	}
}

function appendSegment(parent: DocumentFragment, segment: RenderSegment): void {
	if (segment.kind === "text") {
		const parts = segment.text.split("\n");
		parts.forEach((part, index) => {
			if (index > 0) parent.append(createEl("br"));
			if (part.length > 0) parent.append(part);
		});
		return;
	}

	const tag =
		segment.kind === "deletion"
			? "del"
			: segment.kind === "addition"
				? "ins"
				: segment.kind === "highlight"
					? "mark"
					: "span";
	const el = createEl(tag);
	el.className = `critic-preview-${segment.kind}`;
	if (segment.kind === "highlight" && segment.color) {
		el.addClass(highlightColorClass(segment.color));
	}
	el.textContent = segment.text;
	if (segment.title) el.title = segment.title;
	parent.append(el);
}
