/**
 * Whether CodeMirror's selection still describes what the user sees. A selection inside a
 * `contenteditable="false"` widget produces no transaction, so `state.selection` keeps the
 * previous range; only a DOM selection inside this editor's content can contradict it.
 */
export type SelectionTrust =
	/** The DOM selection is inside the editor and matches the state selection. */
	| "agrees"
	/** The document has no selection range at all; the state selection stands. */
	| "no-dom-selection"
	/** The DOM selection is entirely outside this editor's content; the state selection stands. */
	| "outside-editor"
	/** One end of the DOM selection is inside the editor and the other is not. */
	| "partly-outside"
	/** An end of the DOM selection sits in a `contenteditable="false"` block of this editor. */
	| "uneditable-widget"
	/** The DOM selection is inside the editor but its text disagrees with the state selection. */
	| "text-mismatch";

export interface DomSelectionFacts {
	/** The document selection's text, or null when there is no selection range at all. */
	domText: string | null;
	/** How many ends of the DOM selection sit inside the editor's content element. */
	endsInsideContent: 0 | 1 | 2;
	/** Nearest `contenteditable` value at each end, for ends inside the content element. */
	anchorEditable: string | null;
	focusEditable: string | null;
	/** What CodeMirror believes is selected. */
	stateText: string;
	/** Document offset where `stateText` starts, when the view can map DOM positions. */
	stateFrom?: number;
	/** Document offsets the DOM selection maps to, when both ends are inside the editor. */
	domRange?: { from: number; to: number } | null;
}

const DISTRUSTED: ReadonlySet<SelectionTrust> = new Set<SelectionTrust>([
	"partly-outside",
	"uneditable-widget",
	"text-mismatch",
]);

export function selectionTrust(facts: DomSelectionFacts): SelectionTrust {
	if (facts.domText === null) return "no-dom-selection";
	if (facts.endsInsideContent === 0) return "outside-editor";

	if (facts.anchorEditable === "false" || facts.focusEditable === "false")
		return "uneditable-widget";

	if (facts.endsInsideContent === 1) return "partly-outside";

	if (facts.domRange && facts.stateFrom !== undefined) {
		const stateTo = facts.stateFrom + facts.stateText.length;
		const { from, to } = facts.domRange;
		if (from === facts.stateFrom && to === stateTo) return "agrees";
		// Live Preview hides syntax on inactive lines, so the DOM selection can
		// stop short of the state selection, but only by syntax characters.
		if (from < to && from >= facts.stateFrom && to <= stateTo) {
			const before = facts.stateText.slice(0, from - facts.stateFrom);
			const after = facts.stateText.slice(to - facts.stateFrom);
			if (isHiddenSyntax(before) && isHiddenSyntax(after)) return "agrees";
		}
		return "text-mismatch";
	}

	// Rendered and source text differ in whitespace only.
	if (squeeze(facts.domText) !== squeeze(facts.stateText))
		return "text-mismatch";

	return "agrees";
}

export function isSelectionTrusted(facts: DomSelectionFacts): boolean {
	return !DISTRUSTED.has(selectionTrust(facts));
}

/** The slice of the DOM these helpers touch; real DOM objects satisfy these shapes. */
export interface DomNodeLike {
	nodeType: number;
	parentElement: DomElementLike | null;
}

export interface DomElementLike extends DomNodeLike {
	closest(selector: string): DomElementLike | null;
	getAttribute(name: string): string | null;
	contains(node: DomNodeLike | null): boolean;
}

export interface DomRangeLike {
	startContainer: DomNodeLike;
	startOffset: number;
	endContainer: DomNodeLike;
	endOffset: number;
}

export interface DomSelectionLike {
	rangeCount: number;
	getRangeAt(index: number): DomRangeLike;
	toString(): string;
}

const ELEMENT_NODE = 1;

/**
 * Whether Obsidian mounted this editor inside another to edit a fragment, such as a table
 * cell. Ask per use: the DOM is attached after the view plugin is built.
 */
export function isFragmentEditor(editorDOM: {
	parentElement: DomElementLike | null;
}): boolean {
	return !!editorDOM.parentElement?.closest(".cm-editor");
}

/** The slice of a CodeMirror view the editor-level check reads. */
export interface TrustableEditorView {
	dom: { ownerDocument: { getSelection(): DomSelectionLike | null } };
	contentDOM: DomElementLike;
	state: {
		selection: { main: { from: number; to: number } };
		sliceDoc(from: number, to: number): string;
	};
	posAtDOM?(node: DomNodeLike, offset: number): number;
}

/** The verdict for a live editor's main selection. */
export function editorSelectionTrust(view: TrustableEditorView): SelectionTrust {
	const { from, to } = view.state.selection.main;
	// Positions map only for this editor's own text: an end inside a nested
	// editor (a table cell) maps to the widget, not to what is selected.
	const host = view.contentDOM.closest(".cm-editor");
	const ownText = (node: DomNodeLike): boolean =>
		elementOf(node)?.closest(".cm-editor") === host;
	const mapRange = view.posAtDOM
		? (range: DomRangeLike): { from: number; to: number } | null => {
				if (!ownText(range.startContainer) || !ownText(range.endContainer)) return null;
				try {
					const a = view.posAtDOM!(range.startContainer, range.startOffset);
					const b = view.posAtDOM!(range.endContainer, range.endOffset);
					return a === b ? null : { from: Math.min(a, b), to: Math.max(a, b) };
				} catch {
					return null;
				}
			}
		: undefined;
	return selectionTrust({
		...readDomSelectionFacts(
			view.dom.ownerDocument.getSelection(),
			view.contentDOM,
			view.state.sliceDoc(from, to),
			mapRange,
		),
		stateFrom: from,
	});
}

/** Whether `state.selection` still describes what the user has selected on screen. */
export function isEditorSelectionTrusted(view: TrustableEditorView): boolean {
	return !DISTRUSTED.has(editorSelectionTrust(view));
}

/** Read the facts `selectionTrust` needs from a live document selection. */
export function readDomSelectionFacts(
	selection: DomSelectionLike | null,
	contentDOM: DomElementLike,
	stateText: string,
	mapRange?: (range: DomRangeLike) => { from: number; to: number } | null,
): DomSelectionFacts {
	if (!selection || selection.rangeCount === 0)
		return {
			domText: null,
			endsInsideContent: 0,
			anchorEditable: null,
			focusEditable: null,
			stateText,
		};

	const range = selection.getRangeAt(0);
	const startInside = contains(contentDOM, range.startContainer);
	const endInside = contains(contentDOM, range.endContainer);
	return {
		domText: selection.toString(),
		endsInsideContent: ((startInside ? 1 : 0) + (endInside ? 1 : 0)) as
			| 0
			| 1
			| 2,
		anchorEditable: startInside ? editableOf(range.startContainer) : null,
		focusEditable: endInside ? editableOf(range.endContainer) : null,
		stateText,
		domRange: startInside && endInside && mapRange ? mapRange(range) : null,
	};
}

function elementOf(node: DomNodeLike): DomElementLike | null {
	return node.nodeType === ELEMENT_NODE
		? (node as DomElementLike)
		: node.parentElement;
}

function contains(contentDOM: DomElementLike, node: DomNodeLike): boolean {
	const element = elementOf(node);
	return element ? contentDOM.contains(element) : false;
}

function editableOf(node: DomNodeLike): string | null {
	return (
		elementOf(node)
			?.closest("[contenteditable]")
			?.getAttribute("contenteditable") ?? null
	);
}

function squeeze(value: string): string {
	return value.replace(/\s+/g, "");
}

const SYNTAX_CHARS = new Set("#*_~=`>-+![]()%|");

/** Markdown syntax Live Preview hides on an inactive line, and nothing else.
    A single pass: every character is whitespace, a syntax character, or part
    of an ordered-list number such as `12.`. */
function isHiddenSyntax(value: string): boolean {
	let i = 0;
	while (i < value.length) {
		const char = value[i];
		if (/\s/.test(char) || SYNTAX_CHARS.has(char)) {
			i += 1;
			continue;
		}
		if (/\d/.test(char)) {
			let j = i;
			while (j < value.length && /\d/.test(value[j])) j += 1;
			if (value[j] === "." || value[j] === ")") {
				i = j + 1;
				continue;
			}
		}
		if ((char === "x" || char === "X") && value[i - 1] === "[" && value[i + 1] === "]") {
			i += 1;
			continue;
		}
		return false;
	}
	return true;
}
