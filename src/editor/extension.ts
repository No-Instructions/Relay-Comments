import {
	editorInfoField,
	editorLivePreviewField,
	setIcon,
	setTooltip,
} from "obsidian";
import {
	Prec,
	StateEffect,
	StateField,
	type EditorState,
	type Extension,
	type Range,
} from "@codemirror/state";
import {
	Decoration,
	EditorView,
	ViewPlugin,
	type DecorationSet,
	type ViewUpdate,
} from "@codemirror/view";
import { parseCriticMarkup } from "../critic/parse";
import { findPrecedingWordRange } from "../critic/display";
import { collectAttachedComments } from "../critic/threading";
import type { CriticMark, DisplayMode } from "../critic/types";

export interface ReviewEditorController {
	getDisplayMode(path?: string | null): DisplayMode;
	getRenderVersion(): number;
	shouldShowInlineActions(): boolean;
	activateCommentThread(path: string | null, from: number, to: number): void;
	queueThreadPreview(
		path: string | null,
		from: number,
		to: number,
		anchor: HTMLElement,
	): void;
	scheduleThreadPreviewDismiss(): void;
	hideThreadPreview(): void;
	notifyEditorSelectionChanged(): void;
	startCommentDraft(
		path: string | null,
		from: number,
		to: number,
		selectedText: string,
	): void;
}

interface CommentButtonPlacement {
	left: number;
	top: number;
}

interface CriticFieldValue {
	decorations: DecorationSet;
	atomics: DecorationSet;
	marks: CriticMark[];
	livePreview: boolean;
	domLivePreview: boolean | null;
	renderVersion: number;
	path: string | null;
}

export function createReviewEditorExtension(
	controller: ReviewEditorController,
): Extension {
	// Live-preview state observed from the DOM by the view plugin; the state
	// field itself must stay DOM-free.
	const setDomLivePreview = StateEffect.define<boolean | null>();

	const buildFieldValue = (
		state: EditorState,
		domLivePreview: boolean | null,
	): CriticFieldValue => {
		const livePreview =
			domLivePreview ?? state.field(editorLivePreviewField, false) ?? false;
		const renderVersion = controller.getRenderVersion();
		const path = readPath(state);
		const { decorations, atomics, marks } = buildDecorations(
			state,
			livePreview,
			controller,
		);
		return {
			decorations,
			atomics,
			marks,
			livePreview,
			domLivePreview,
			renderVersion,
			path,
		};
	};

	// Block decorations (used to hide comment markup that spans line breaks)
	// may only be provided by a state field, not a view plugin.
	const criticField = StateField.define<CriticFieldValue>({
		create(state) {
			return buildFieldValue(state, null);
		},
		update(value, tr) {
			let domLivePreview = value.domLivePreview;
			for (const effect of tr.effects) {
				if (effect.is(setDomLivePreview)) {
					domLivePreview = effect.value;
				}
			}
			const livePreview =
				domLivePreview ??
				tr.state.field(editorLivePreviewField, false) ??
				false;
			if (
				!tr.docChanged &&
				domLivePreview === value.domLivePreview &&
				livePreview === value.livePreview &&
				controller.getRenderVersion() === value.renderVersion &&
				readPath(tr.state) === value.path
			) {
				return value;
			}
			return buildFieldValue(tr.state, domLivePreview);
		},
		provide: (field) => [
			EditorView.decorations.from(field, (value) => value.decorations),
			EditorView.atomicRanges.of(
				(view) => view.state.field(field).atomics,
			),
		],
	});

	const reviewViewPlugin = ViewPlugin.fromClass(
		class {
			private commentButton: HTMLButtonElement;
			private sourceViewEl: HTMLElement | null = null;
			private sourceViewObserver: MutationObserver | null = null;
			private livePreviewPollId: number | null = null;
			private lastDomSignal: boolean | null = null;
			private destroyed = false;
			private handleClick = (event: MouseEvent): void => {
				const target = event.target as HTMLElement | null;
				const anchor = target?.closest<HTMLElement>(
					".cm-critic-thread-anchor",
				);
				if (!anchor) return;
				const from = Number(anchor.dataset.criticFrom);
				const to = Number(anchor.dataset.criticTo);
				if (!Number.isFinite(from) || !Number.isFinite(to)) return;
				controller.activateCommentThread(
					readPath(this.view.state),
					from,
					to,
				);
			};
			private handlePointerOver = (event: PointerEvent): void => {
				const target = event.target as HTMLElement | null;
				const anchor = target?.closest<HTMLElement>(
					".cm-critic-thread-anchor",
				);
				if (!anchor || !this.view.dom.contains(anchor)) return;
				const from = Number(anchor.dataset.criticFrom);
				const to = Number(anchor.dataset.criticTo);
				if (!Number.isFinite(from) || !Number.isFinite(to)) return;
				if (event.buttons !== 0) return;
				controller.queueThreadPreview(readPath(this.view.state), from, to, anchor);
			};
			private handlePointerOut = (event: PointerEvent): void => {
				const target = event.target as HTMLElement | null;
				const anchor = target?.closest<HTMLElement>(
					".cm-critic-thread-anchor",
				);
				if (!anchor || !this.view.dom.contains(anchor)) return;
				const related = event.relatedTarget as Node | null;
				if (related && anchor.contains(related)) return;
				controller.scheduleThreadPreviewDismiss();
			};

			constructor(private view: EditorView) {
				this.commentButton = this.createCommentButton();
				this.view.dom.appendChild(this.commentButton);
				this.view.dom.addEventListener("click", this.handleClick);
				this.view.dom.addEventListener("pointerover", this.handlePointerOver);
				this.view.dom.addEventListener("pointerout", this.handlePointerOut);
				this.observeSourceView();
				this.syncDomLivePreview();
				this.livePreviewPollId = window.setInterval(
					() => this.syncDomLivePreview(),
					500,
				);
				this.scheduleCommentButtonUpdate();
			}

			update(update: ViewUpdate): void {
				this.observeSourceView();
				if (update.selectionSet) {
					controller.notifyEditorSelectionChanged();
				}
				if (
					update.selectionSet ||
					update.docChanged ||
					update.viewportChanged ||
					update.startState.field(criticField) !==
						update.state.field(criticField)
				) {
					this.scheduleCommentButtonUpdate();
				}
			}

			destroy(): void {
				this.destroyed = true;
				this.sourceViewObserver?.disconnect();
				this.sourceViewObserver = null;
				if (this.livePreviewPollId !== null) {
					window.clearInterval(this.livePreviewPollId);
					this.livePreviewPollId = null;
				}
				this.view.dom.removeEventListener("click", this.handleClick);
				this.view.dom.removeEventListener("pointerover", this.handlePointerOver);
				this.view.dom.removeEventListener("pointerout", this.handlePointerOut);
				controller.hideThreadPreview();
				this.commentButton.remove();
			}

			private observeSourceView(): void {
				const sourceView = this.view.dom.closest(
					".markdown-source-view",
				) as HTMLElement | null;
				if (sourceView === this.sourceViewEl) return;

				this.sourceViewObserver?.disconnect();
				this.sourceViewEl = sourceView;
				if (!sourceView) return;

				this.sourceViewObserver = new MutationObserver(() => {
					this.syncDomLivePreview();
				});
				this.sourceViewObserver.observe(sourceView, {
					attributes: true,
					attributeFilter: ["class"],
				});
			}

			private syncDomLivePreview(): void {
				const sourceView = this.view.dom.closest(".markdown-source-view");
				const domSignal = sourceView
					? sourceView.classList.contains("is-live-preview")
					: null;
				if (domSignal === this.lastDomSignal) return;
				this.lastDomSignal = domSignal;
				queueMicrotask(() => {
					if (this.destroyed) return;
					this.view.dispatch({
						effects: setDomLivePreview.of(domSignal),
					});
				});
			}

			private createCommentButton(): HTMLButtonElement {
				const button = this.view.dom.ownerDocument.createElement("button");
				button.className = "cm-critic-comment-button";
				button.type = "button";
				// setTooltip, never the title attribute: a title makes the
				// browser's native tooltip appear alongside Obsidian's styled one.
				button.setAttribute("aria-label", "Add comment");
				setTooltip(button, "Add comment");
				setIcon(button, "message-square-plus");
				button.addEventListener("mousedown", (event) => {
					event.preventDefault();
					event.stopPropagation();
				});
				button.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					const selection = this.view.state.selection.main;
					if (selection.empty) return;
					controller.startCommentDraft(
						readPath(this.view.state),
						selection.from,
						selection.to,
						this.view.state.sliceDoc(selection.from, selection.to),
					);
				});
				return button;
			}

			private scheduleCommentButtonUpdate(): void {
				this.view.requestMeasure({
					read: () => this.measureCommentButton(),
					write: (placement) => this.applyCommentButtonPlacement(placement),
				});
			}

			private measureCommentButton(): CommentButtonPlacement | null {
				const selection = this.view.state.selection.main;
				const fieldValue = this.view.state.field(criticField);
				if (
					!controller.shouldShowInlineActions() ||
					!fieldValue.livePreview ||
					selection.empty
				) {
					return null;
				}
				const selectedText = this.view.state.sliceDoc(
					selection.from,
					selection.to,
				);
				if (selectedText.trim().length === 0) {
					return null;
				}
				// CriticMarkup can't express overlapping marks; don't offer a
				// comment that would nest inside existing markup.
				if (
					fieldValue.marks.some(
						(mark) => mark.from < selection.to && mark.to > selection.from,
					)
				) {
					return null;
				}

				const coords = this.view.coordsAtPos(selection.to);
				if (!coords) return null;

				// Sit in the editor's right margin (like Google Docs) instead
				// of floating over the text that follows the selection.
				const editorRect = this.view.dom.getBoundingClientRect();
				const contentRect = this.view.contentDOM.getBoundingClientRect();
				const left = Math.min(
					contentRect.right - editorRect.left + 12,
					editorRect.width - 40,
				);
				const top = coords.top - editorRect.top - 6;
				return { left: Math.round(left), top: Math.round(top) };
			}

			private applyCommentButtonPlacement(
				placement: CommentButtonPlacement | null,
			): void {
				if (!placement) {
					this.commentButton.classList.remove("is-visible");
					return;
				}
				this.commentButton.style.left = `${placement.left}px`;
				this.commentButton.style.top = `${placement.top}px`;
				this.commentButton.classList.add("is-visible");
			}
		},
	);

	return [Prec.highest(criticField), reviewViewPlugin, reviewEditorTheme];
}

function readPath(state: EditorState): string | null {
	const fileInfo = state.field(editorInfoField, false);
	return fileInfo?.file?.path ?? null;
}

function buildDecorations(
	state: EditorState,
	livePreview: boolean,
	controller: ReviewEditorController,
): { decorations: DecorationSet; atomics: DecorationSet; marks: CriticMark[] } {
	if (!livePreview) {
		return { decorations: Decoration.none, atomics: Decoration.none, marks: [] };
	}
	try {
		return buildDecorationsInner(state, controller);
	} catch (error) {
		console.error("[Relay Comments] decoration build failed", error);
		return { decorations: Decoration.none, atomics: Decoration.none, marks: [] };
	}
}

function buildDecorationsInner(
	state: EditorState,
	controller: ReviewEditorController,
): { decorations: DecorationSet; atomics: DecorationSet; marks: CriticMark[] } {
	const text = state.doc.toString();
	const path = readPath(state);
	const mode = controller.getDisplayMode(path);
	const ranges: Array<Range<Decoration>> = [];
	const atomRanges: Array<Range<Decoration>> = [];
	const marks = parseCriticMarkup(text);
	const anchoredComments = findAnchoredComments(marks, text);

	for (const mark of marks) {
		if (!mark.valid) {
			// Never hide invalid/incomplete markup: the user may be mid-typing,
			// and replacing it would blank out real text.
			addMark(ranges, mark.from, mark.to, "cm-critic-invalid", mark.error);
			continue;
		}
		if (anchoredComments.commentIds.has(mark.id)) {
			// Rendered as part of its thread anchor below.
			continue;
		}

		const attached = anchoredComments.byAnchorId.get(mark.id) ?? [];
		const separators =
			anchoredComments.separatorRangesByAnchorId.get(mark.id) ?? [];

		if (mark.type === "comment") {
			// Comment thread root: anchor the thread to the preceding word
			// (Google Docs-style) and hide the markup itself. Threads with no
			// visible text render nothing at all.
			const threadTexts = [mark, ...attached]
				.map((comment) => comment.content.trim())
				.filter((content) => content.length > 0);
			if (mode !== "clean" && threadTexts.length > 0) {
				const anchor = findPrecedingWordRange(text, mark.from, marks);
				if (anchor) {
					// No native title: the rich hover preview owns this anchor,
					// and a title pops the browser tooltip next to it.
					addMark(
						ranges,
						anchor[0],
						anchor[1],
						"cm-critic-comment-anchor cm-critic-thread-anchor",
						undefined,
						{
							"data-critic-from": String(mark.from),
							"data-critic-to": String(mark.to),
						},
					);
				}
			}
			addReplace(ranges, mark.from, mark.to, mark.raw.includes("\n"));
			addAtom(atomRanges, mark.from, mark.to);
		} else if (mode === "clean") {
			decorateClean(mark, ranges);
		} else {
			decorateReview(
				mark,
				ranges,
				attached.length > 0 ? threadAttributes(mark, attached) : undefined,
			);
		}

		hideRanges(text, separators, ranges, atomRanges);
		for (const comment of attached) {
			addReplace(ranges, comment.from, comment.to, comment.raw.includes("\n"));
			addAtom(atomRanges, comment.from, comment.to);
		}
	}

	ranges.sort((a, b) => a.from - b.from || a.to - b.to);
	atomRanges.sort((a, b) => a.from - b.from || a.to - b.to);
	return {
		decorations: Decoration.set(ranges, true),
		atomics: Decoration.set(atomRanges, true),
		marks,
	};
}

function decorateReview(
	mark: CriticMark,
	ranges: Array<Range<Decoration>>,
	threadAttrs?: Record<string, string>,
): void {
	hideDelimiters(mark, ranges);

	switch (mark.type) {
		case "addition":
			addMark(
				ranges,
				mark.contentFrom,
				mark.contentTo,
				attributeClass("cm-critic-addition", threadAttrs),
				undefined,
				threadAttrs,
			);
			break;
		case "deletion":
			addMark(
				ranges,
				mark.contentFrom,
				mark.contentTo,
				attributeClass("cm-critic-deletion", threadAttrs),
				undefined,
				threadAttrs,
			);
			break;
		case "substitution":
			if (mark.ranges.separator) {
				addReplace(ranges, mark.ranges.separator[0], mark.ranges.separator[1]);
			}
			if (mark.ranges.oldText) {
				addMark(
					ranges,
					mark.ranges.oldText[0],
					mark.ranges.oldText[1],
					attributeClass("cm-critic-deletion", threadAttrs),
					undefined,
					threadAttrs,
				);
			}
			if (mark.ranges.newText) {
				addMark(
					ranges,
					mark.ranges.newText[0],
					mark.ranges.newText[1],
					attributeClass("cm-critic-addition", threadAttrs),
					undefined,
					threadAttrs,
				);
			}
			break;
		case "highlight":
			addMark(
				ranges,
				mark.contentFrom,
				mark.contentTo,
				attributeClass("cm-critic-highlight", threadAttrs),
				undefined,
				threadAttrs,
			);
			break;
		case "comment":
			// Comment roots are handled in buildDecorationsInner().
			break;
	}
}

function decorateClean(
	mark: CriticMark,
	ranges: Array<Range<Decoration>>,
): void {
	switch (mark.type) {
		case "addition":
		case "highlight":
			hideDelimiters(mark, ranges);
			break;
		case "deletion":
		case "comment":
			addReplace(ranges, mark.from, mark.to, mark.raw.includes("\n"));
			break;
		case "substitution":
			if (mark.ranges.opening && mark.ranges.newText) {
				addReplace(
					ranges,
					mark.ranges.opening[0],
					mark.ranges.newText[0],
					(mark.oldText ?? "").includes("\n"),
				);
			}
			if (mark.ranges.closing) {
				addReplace(ranges, mark.ranges.closing[0], mark.ranges.closing[1]);
			}
			break;
	}
}

function findAnchoredComments(
	marks: CriticMark[],
	text: string,
): {
	commentIds: Set<string>;
	byAnchorId: Map<string, CriticMark[]>;
	separatorRangesByAnchorId: Map<string, Array<[number, number]>>;
} {
	const commentIds = new Set<string>();
	const byAnchorId = new Map<string, CriticMark[]>();
	const separatorRangesByAnchorId = new Map<string, Array<[number, number]>>();
	for (let index = 0; index < marks.length; index += 1) {
		const mark = marks[index];
		if (!mark.valid || commentIds.has(mark.id)) continue;

		const attached = collectAttachedComments(marks, text, index, commentIds, {
			allowCommentAnchor: true,
		});
		if (attached.comments.length > 0) {
			for (const comment of attached.comments) {
				commentIds.add(comment.id);
			}
			byAnchorId.set(mark.id, attached.comments);
			if (attached.separatorRanges.length > 0) {
				separatorRangesByAnchorId.set(mark.id, attached.separatorRanges);
			}
		}
	}
	return { commentIds, byAnchorId, separatorRangesByAnchorId };
}

function hideRanges(
	text: string,
	sourceRanges: Array<[number, number]>,
	ranges: Array<Range<Decoration>>,
	atomRanges: Array<Range<Decoration>>,
): void {
	for (const [from, to] of sourceRanges) {
		addReplace(ranges, from, to, text.slice(from, to).includes("\n"));
		addAtom(atomRanges, from, to);
	}
}

function hideDelimiters(
	mark: CriticMark,
	ranges: Array<Range<Decoration>>,
): void {
	if (mark.ranges.opening) {
		addReplace(ranges, mark.ranges.opening[0], mark.ranges.opening[1]);
	}
	if (mark.ranges.closing) {
		addReplace(ranges, mark.ranges.closing[0], mark.ranges.closing[1]);
	}
}

// No native title here either: these anchors get the rich hover preview,
// and a title would double it with the browser's own tooltip. (Reading
// mode, which has no preview, keeps its title in critic/render.ts.)
function threadAttributes(
	mark: CriticMark,
	comments: CriticMark[],
): Record<string, string> {
	return {
		"data-critic-from": String(mark.from),
		"data-critic-to": String(mark.to),
	};
}

function attributeClass(
	className: string,
	attributes?: Record<string, string>,
): string {
	return attributes ? `${className} cm-critic-thread-anchor` : className;
}

function addMark(
	ranges: Array<Range<Decoration>>,
	from: number,
	to: number,
	className: string,
	title?: string,
	attributes?: Record<string, string>,
): void {
	if (to <= from) return;
	const markAttributes: Record<string, string> | undefined =
		attributes || title ? { ...(attributes ?? {}) } : undefined;
	if (title && markAttributes) {
		markAttributes.title = title;
	}
	ranges.push(
		Decoration.mark({
			class: className,
			attributes: markAttributes,
		}).range(from, to),
	);
}

function addReplace(
	ranges: Array<Range<Decoration>>,
	from: number,
	to: number,
	block = false,
): void {
	if (to <= from) return;
	ranges.push(
		Decoration.replace({
			inclusive: false,
			block,
		}).range(from, to),
	);
}

function addAtom(ranges: Array<Range<Decoration>>, from: number, to: number): void {
	if (to <= from) return;
	ranges.push(Decoration.mark({}).range(from, to));
}

const reviewEditorTheme = EditorView.baseTheme({
	"&": {
		position: "relative",
	},
});
