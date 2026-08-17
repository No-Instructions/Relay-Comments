/**
 * Whether CodeMirror's selection still describes what the user has selected on screen.
 *
 * Obsidian renders tables, and other embedded blocks, as widgets marked
 * `contenteditable="false"`. A selection made inside one is a real DOM selection that produces no
 * CodeMirror transaction at all, because CodeMirror's own state never changes. Its
 * `state.selection` therefore keeps describing the *previous* selection, and reports itself
 * non-empty - so a range that looks perfectly valid actually points somewhere the user is no
 * longer looking.
 *
 * Anything reading `state.selection` to place an edit has to ask this first. Containment in
 * `contentDOM` cannot answer it: widgets live inside the content element too.
 */
export type SelectionTrust =
	| "trusted"
	| "no-dom-selection"
	| "outside-editor"
	| "uneditable-widget"
	| "text-mismatch";

export interface DomSelectionFacts {
	/** The document selection's text, or null when there is no selection at all. */
	domText: string | null;
	/** Whether both ends of the DOM selection are inside the editor's content element. */
	insideContent: boolean;
	/**
	 * The `contenteditable` value of the nearest such ancestor at each end of the DOM selection.
	 * `"false"` marks a widget CodeMirror does not accept text selection from.
	 */
	anchorEditable: string | null;
	focusEditable: string | null;
	/** What CodeMirror believes is selected. */
	stateText: string;
}

export function selectionTrust(facts: DomSelectionFacts): SelectionTrust {
	if (facts.domText === null) return "no-dom-selection";

	if (!facts.insideContent) return "outside-editor";

	if (facts.anchorEditable === "false" || facts.focusEditable === "false")
		return "uneditable-widget";

	// Whitespace differs freely between rendered DOM and source text, so compare only the
	// non-whitespace content. A widget that reported no `contenteditable` at all still fails here.
	if (squeeze(facts.domText) !== squeeze(facts.stateText))
		return "text-mismatch";

	return "trusted";
}

export function isSelectionTrusted(facts: DomSelectionFacts): boolean {
	return selectionTrust(facts) === "trusted";
}

/**
 * Whether this editor is one Obsidian mounted inside another to edit a fragment.
 *
 * Editing a table cell, and other embedded blocks, gets its own CodeMirror view whose whole
 * document is that fragment - `"1.8.26"` for one cell. Editor extensions are installed in it too,
 * so anything that assumes one view per note gets a second instance working on a different
 * document: a duplicate floating button inside the table, and decorations computed against text
 * Obsidian's own renderer has already marked up.
 *
 * Nesting is the test rather than a table-specific class, so callouts and embeds are covered by
 * the same check.
 */
export function isFragmentEditor(editorDOM: HTMLElement): boolean {
	return !!editorDOM.parentElement?.closest(".cm-editor");
}

/** Read the facts `selectionTrust` needs from a live document selection. */
export function readDomSelectionFacts(
	selection: Selection | null,
	contentDOM: HTMLElement,
	stateText: string,
): DomSelectionFacts {
	if (!selection || selection.rangeCount === 0)
		return {
			domText: null,
			insideContent: false,
			anchorEditable: null,
			focusEditable: null,
			stateText,
		};

	const range = selection.getRangeAt(0);
	return {
		domText: selection.toString(),
		insideContent:
			contains(contentDOM, range.startContainer) &&
			contains(contentDOM, range.endContainer),
		anchorEditable: editableOf(range.startContainer),
		focusEditable: editableOf(range.endContainer),
		stateText,
	};
}

function elementOf(node: Node): Element | null {
	return node.nodeType === Node.ELEMENT_NODE
		? (node as Element)
		: node.parentElement;
}

function contains(contentDOM: HTMLElement, node: Node): boolean {
	const element = elementOf(node);
	return element ? contentDOM.contains(element) : false;
}

function editableOf(node: Node): string | null {
	return (
		elementOf(node)?.closest("[contenteditable]")?.getAttribute("contenteditable") ??
		null
	);
}

function squeeze(value: string): string {
	return value.replace(/\s+/g, "");
}
