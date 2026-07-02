import type { MarkdownPostProcessorContext } from "obsidian";
import { renderDisplaySegments } from "../critic/render";
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

export function createCriticMarkupPostProcessor(
	controller: PreviewDisplayController,
) {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
		const configuredMode = controller.getDisplayMode(ctx.sourcePath);
		const mode = configuredMode === "raw" ? "review" : configuredMode;

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

	const fragment = node.ownerDocument.createDocumentFragment();
	for (const segment of segments) {
		appendSegment(fragment, segment);
	}
	node.replaceWith(fragment);
}

function appendSegment(parent: DocumentFragment, segment: RenderSegment): void {
	if (segment.kind === "text") {
		parent.append(segment.text);
		return;
	}

	const doc = parent.ownerDocument;
	const tag =
		segment.kind === "deletion"
			? "del"
			: segment.kind === "addition"
				? "ins"
				: segment.kind === "highlight"
					? "mark"
					: "span";
	const el = doc.createElement(tag);
	el.className = `critic-preview-${segment.kind}`;
	el.textContent = segment.text;
	if (segment.title) el.title = segment.title;
	parent.append(el);
}
