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

export interface DomSelectionLike {
	rangeCount: number;
	getRangeAt(index: number): {
		startContainer: DomNodeLike;
		endContainer: DomNodeLike;
	};
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
}

/** The verdict for a live editor's main selection. */
export function editorSelectionTrust(view: TrustableEditorView): SelectionTrust {
	const { from, to } = view.state.selection.main;
	return selectionTrust(
		readDomSelectionFacts(
			view.dom.ownerDocument.getSelection(),
			view.contentDOM,
			view.state.sliceDoc(from, to),
		),
	);
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
