import {
	type MarkdownPostProcessorContext,
	type MarkdownSectionInformation,
} from "obsidian";
import { parseCriticMarkup } from "../critic/parse";
import { renderDisplaySegments, renderSliceSegments } from "../critic/render";
import type { DisplayMode, RenderSegment } from "../critic/types";

export interface PreviewDisplayController {
	getDisplayMode(path?: string | null): DisplayMode;
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
const SOURCE_RENDER_SELECTOR =
	"p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th";

export function createReviewPostProcessor(
	controller: PreviewDisplayController,
) {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
		const mode = controller.getDisplayMode(ctx.sourcePath);
		rewriteSourceBackedElements(el, ctx, mode);

		const walker = el.ownerDocument.createTreeWalker(
			el,
			NodeFilter.SHOW_TEXT,
			{
				acceptNode(node) {
					const parent = node.parentElement;
					if (!parent || shouldSkip(parent)) return NodeFilter.FILTER_REJECT;
					const text = node.nodeValue ?? "";
					return text.includes("{")
						? NodeFilter.FILTER_ACCEPT
						: NodeFilter.FILTER_SKIP;
				},
			},
		);

		const nodes: Text[] = [];
		while (walker.nextNode()) {
			nodes.push(walker.currentNode as Text);
		}

		for (const node of nodes) {
			replaceTextNode(node, mode);
		}
	};
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
		const section = ctx.getSectionInfo(candidate);
		const source = section?.text;
		if (!source || !SOURCE_PATTERN.test(source)) continue;
		if (section && rewriteMultilineSlice(candidate, section, mode)) {
			rewritten.add(candidate);
			continue;
		}
		const sourceText = selectSourceTextForElement(candidate, source);
		if (!sourceText) continue;
		rewriteElementFromSource(candidate, normalizeSectionText(candidate, sourceText), mode);
		rewritten.add(candidate);
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
	// Only plain paragraphs: other blocks (lists, quotes, headings) carry
	// per-line Markdown prefixes that offset-based slicing can't honor.
	if (el.tagName !== "P") return false;

	const text = section.text;
	const lines = text.split("\n");
	if (section.lineStart >= lines.length) return false;
	let from = 0;
	for (let i = 0; i < section.lineStart; i += 1) {
		from += lines[i].length + 1;
	}
	let to = from;
	const lastLine = Math.min(section.lineEnd, lines.length - 1);
	for (let i = section.lineStart; i <= lastLine; i += 1) {
		to += lines[i].length + 1;
	}
	to = Math.min(to - 1, text.length);

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

function selectSourceTextForElement(
	el: HTMLElement,
	sectionSource: string,
): string | null {
	const domText = el.textContent ?? "";
	if (!DOM_REMNANT_PATTERN.test(domText)) return null;

	const sourceLines = sectionSource
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => SOURCE_PATTERN.test(line));
	if (sourceLines.length === 0) return null;
	if (sourceLines.length === 1) return sourceLines[0];

	// Marks spanning line breaks cannot be reconstructed line by line; the
	// slice-based path handles paragraphs, and other blocks are left with
	// visible source rather than risking corruption.
	if (
		parseCriticMarkup(sectionSource).some(
			(mark) => mark.valid && mark.raw.includes("\n"),
		)
	) {
		return null;
	}

	const domWords = words(domText);
	let bestLine: string | null = null;
	let bestScore = 0;
	for (const line of sourceLines) {
		const normalizedLine = normalizeSectionText(el, line);
		const searchText = `${line} ${getRenderedSearchText(normalizedLine)}`;
		const sourceWords = words(searchText);
		const score = sourceWords.filter((word) => domWords.includes(word)).length;
		if (score > bestScore) {
			bestLine = line;
			bestScore = score;
		}
	}
	return bestScore > 0 ? bestLine : null;
}

function elementCoversSource(el: HTMLElement, source: string): boolean {
	const domWords = words(el.textContent ?? "");
	const sourceWords = words(`${source} ${getRenderedSearchText(source)}`);
	if (domWords.length === 0 || sourceWords.length === 0) return false;
	const domInSource =
		domWords.filter((word) => sourceWords.includes(word)).length /
		domWords.length;
	const sourceInDom =
		sourceWords.filter((word) => domWords.includes(word)).length /
		sourceWords.length;
	return domInSource >= 0.7 && sourceInDom >= 0.7;
}

function getRenderedSearchText(source: string): string {
	return renderDisplaySegments(source, "review")
		.map((segment) => `${segment.text} ${segment.title ?? ""}`)
		.join(" ");
}

function words(text: string): string[] {
	return Array.from(
		new Set(text.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 1) ?? []),
	);
}

function normalizeSectionText(el: HTMLElement, source: string): string {
	const tag = el.tagName;
	if (/^H[1-6]$/.test(tag)) {
		return source.replace(/^#{1,6}\s+/, "");
	}
	if (tag === "LI") {
		return source.replace(/^(\s*)(?:[-*+]|\d+[.)])\s+/, "$1");
	}
	if (tag === "BLOCKQUOTE") {
		return source
			.split("\n")
			.map((line) => line.replace(/^>\s?/, ""))
			.join("\n");
	}
	return source;
}

function rewriteElementFromSource(
	el: HTMLElement,
	source: string,
	mode: DisplayMode,
): void {
	const segments = renderDisplaySegments(source, mode);
	if (segments.length === 1 && segments[0].kind === "text") return;

	const fragment = createFragment();
	for (const segment of segments) {
		appendSegment(fragment, segment);
	}
	el.replaceChildren(fragment);
	el.addClass("critic-preview-source-rendered");
}

function shouldSkip(el: HTMLElement): boolean {
	let current: HTMLElement | null = el;
	while (current) {
		if (SKIP_TAGS.has(current.tagName)) return true;
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
	el.textContent = segment.text;
	if (segment.title) el.title = segment.title;
	parent.append(el);
}
