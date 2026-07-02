import { editorInfoField, editorLivePreviewField, setIcon } from "obsidian";
import { Prec, type Extension, type Range } from "@codemirror/state";
import {
	Decoration,
	EditorView,
	ViewPlugin,
	type DecorationSet,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { parseCriticMarkup } from "../critic/parse";
import { collectAttachedComments } from "../critic/threading";
import type { CriticMark, DisplayMode } from "../critic/types";

export interface CriticMarkupEditorController {
	getDisplayMode(path?: string | null): DisplayMode;
	getRenderVersion(): number;
	shouldShowInlineActions(): boolean;
	activateCommentThread(path: string | null, from: number, to: number): void;
	startCommentDraft(
		path: string | null,
		from: number,
		to: number,
		selectedText: string,
	): void;
}

class IconWidget extends WidgetType {
	constructor(
		private className: string,
		private icon: string,
		private title?: string,
	) {
		super();
	}

	toDOM(view: EditorView): HTMLElement {
		const span = view.dom.ownerDocument.createElement("span");
		span.className = this.className;
		if (this.title) span.title = this.title;
		setIcon(span, this.icon);
		return span;
	}

	eq(other: IconWidget): boolean {
		return (
			this.className === other.className &&
			this.icon === other.icon &&
			this.title === other.title
		);
	}
}

export function createCriticMarkupExtension(
	controller: CriticMarkupEditorController,
): Extension {
	const criticMarkupPlugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet = Decoration.none;
			atomicRanges: DecorationSet = Decoration.none;
			private renderVersion = -1;
			private commentButton: HTMLButtonElement;
			private sourceViewEl: HTMLElement | null = null;
			private sourceViewObserver: MutationObserver | null = null;
			private path: string | null = null;
			private mode: DisplayMode = "review";
			private livePreview = false;
			private handleClick = (event: MouseEvent): void => {
				const target = event.target as HTMLElement | null;
				const anchor = target?.closest<HTMLElement>(
					".cm-critic-thread-anchor, .cm-critic-anchored-comment",
				);
				if (!anchor) return;
				const from = Number(anchor.dataset.criticFrom);
				const to = Number(anchor.dataset.criticTo);
				if (!Number.isFinite(from) || !Number.isFinite(to)) return;
				controller.activateCommentThread(readPath(this.view), from, to);
			};

			constructor(private view: EditorView) {
				this.commentButton = this.createCommentButton();
				this.view.dom.appendChild(this.commentButton);
				this.view.dom.addEventListener("click", this.handleClick);
				this.rebuild();
				this.observeSourceView();
				this.view.requestMeasure({
					read: () => null,
					write: () => {
						this.observeSourceView();
						this.rebuildIfLivePreviewChanged();
					},
				});
			}

			update(update: ViewUpdate): void {
				const nextVersion = controller.getRenderVersion();
				const nextPath = readPath(update.view);
				const nextMode = controller.getDisplayMode(nextPath);
				const nextLivePreview = readLivePreview(update.view);
				if (
					update.docChanged ||
					update.selectionSet ||
					update.viewportChanged ||
					nextVersion !== this.renderVersion ||
					nextPath !== this.path ||
					nextMode !== this.mode ||
					nextLivePreview !== this.livePreview
				) {
					this.observeSourceView();
					this.rebuild();
				} else {
					this.observeSourceView();
					this.updateCommentButton();
				}
			}

			destroy(): void {
				this.sourceViewObserver?.disconnect();
				this.sourceViewObserver = null;
				this.view.dom.removeEventListener("click", this.handleClick);
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
					this.rebuildIfLivePreviewChanged();
				});
				this.sourceViewObserver.observe(sourceView, {
					attributes: true,
					attributeFilter: ["class"],
				});
			}

			private rebuildIfLivePreviewChanged(): void {
				const livePreview = readLivePreview(this.view);
				if (livePreview !== this.livePreview) {
					this.rebuild();
					this.view.dispatch({});
				}
			}

			private createCommentButton(): HTMLButtonElement {
				const button = this.view.dom.ownerDocument.createElement("button");
				button.className = "cm-critic-comment-button";
				button.type = "button";
				button.setAttribute("aria-label", "Add CriticMarkup comment");
				button.title = "Add comment";
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
						readPath(this.view),
						selection.from,
						selection.to,
						this.view.state.sliceDoc(selection.from, selection.to),
					);
				});
				return button;
			}

			private rebuild(): void {
				this.renderVersion = controller.getRenderVersion();
				const text = this.view.state.doc.toString();
				const path = readPath(this.view);
				const mode = controller.getDisplayMode(path);
				const livePreview = readLivePreview(this.view);
				this.path = path;
				this.mode = mode;
				this.livePreview = livePreview;
				const ranges: Array<Range<Decoration>> = [];
				const atomRanges: Array<Range<Decoration>> = [];
				const marks = parseCriticMarkup(text);
				const anchoredComments = findAnchoredComments(marks, text);

				for (const mark of marks) {
					if (!mark.valid) {
						addReplace(
							ranges,
							mark.from,
							mark.to,
							new IconWidget(
								"cm-critic-invalid-widget",
								"alert-triangle",
								mark.error,
							),
						);
						addAtom(atomRanges, mark.from, mark.to);
						continue;
					}

					const anchoredComment = anchoredComments.byAnchorId.get(mark.id);
					if (anchoredComment && anchoredComment.length > 0) {
						const separators =
							anchoredComments.separatorRangesByAnchorId.get(mark.id) ?? [];
						if (mode === "clean") {
							this.decorateClean(mark, true, ranges);
							hideRanges(separators, ranges, atomRanges);
							for (const comment of anchoredComment) {
								addReplace(ranges, comment.from, comment.to);
								addAtom(atomRanges, comment.from, comment.to);
							}
						} else {
							this.decorateReview(
								mark,
								true,
								ranges,
								anchoredComments.commentIds,
								threadAttributes(mark, anchoredComment),
							);
							hideRanges(separators, ranges, atomRanges);
							for (const comment of anchoredComment) {
								addReplace(ranges, comment.from, comment.to);
								addAtom(atomRanges, comment.from, comment.to);
							}
						}
						continue;
					}
					if (anchoredComments.commentIds.has(mark.id)) {
						continue;
					}
					if (mode === "clean") {
						this.decorateClean(mark, true, ranges);
					} else {
						this.decorateReview(mark, true, ranges, anchoredComments.commentIds);
					}
				}

				ranges.sort((a, b) => a.from - b.from || a.to - b.to);
				atomRanges.sort((a, b) => a.from - b.from || a.to - b.to);
				this.decorations = Decoration.set(ranges, true);
				this.atomicRanges = Decoration.set(atomRanges, true);
				this.updateCommentButton();
			}

			private decorateReview(
				mark: CriticMark,
				hideRaw: boolean,
				ranges: Array<Range<Decoration>>,
				anchoredCommentIds: Set<string> = new Set(),
				threadAttrs?: Record<string, string>,
			): void {
				if (mark.type === "comment" && hideRaw) {
					if (anchoredCommentIds.has(mark.id)) {
						addReplace(ranges, mark.from, mark.to);
						return;
					}
					hideDelimiters(mark, ranges);
					return;
				}

				if (hideRaw) hideDelimiters(mark, ranges);

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
						if (hideRaw && mark.ranges.separator) {
							addReplace(
								ranges,
								mark.ranges.separator[0],
								mark.ranges.separator[1],
							);
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
					case "comment":
						addMark(ranges, mark.from, mark.to, "cm-critic-comment-raw");
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
				}
			}

			private decorateClean(
				mark: CriticMark,
				hideRaw: boolean,
				ranges: Array<Range<Decoration>>,
			): void {
				if (!hideRaw) {
					this.decorateReview(mark, false, ranges);
					return;
				}

				switch (mark.type) {
					case "addition":
					case "highlight":
						hideDelimiters(mark, ranges);
						break;
					case "deletion":
						addReplace(ranges, mark.from, mark.to);
						break;
					case "comment":
						hideDelimiters(mark, ranges);
						break;
					case "substitution":
						if (mark.ranges.opening && mark.ranges.newText) {
							addReplace(ranges, mark.ranges.opening[0], mark.ranges.newText[0]);
						}
						if (mark.ranges.closing) {
							addReplace(ranges, mark.ranges.closing[0], mark.ranges.closing[1]);
						}
						break;
				}
			}

			private updateCommentButton(): void {
				const selection = this.view.state.selection.main;
				const selectedText = selection.empty
					? ""
					: this.view.state.sliceDoc(selection.from, selection.to);
				if (
					!controller.shouldShowInlineActions() ||
					!this.livePreview ||
					selection.empty ||
					selectedText.trim().length === 0
				) {
					this.commentButton.classList.remove("is-visible");
					return;
				}

				const coords = this.view.coordsAtPos(selection.to);
				if (!coords) {
					this.commentButton.classList.remove("is-visible");
					return;
				}

				const editorRect = this.view.dom.getBoundingClientRect();
				const left = Math.min(
					Math.max(coords.right - editorRect.left + 8, 8),
					editorRect.width - 34,
				);
				const top = coords.top - editorRect.top - 5;

				this.commentButton.style.left = `${Math.round(left)}px`;
				this.commentButton.style.top = `${Math.round(top)}px`;
				this.commentButton.classList.add("is-visible");
			}
		},
		{
			decorations: (value) => value.decorations,
			provide: (plugin) =>
				EditorView.atomicRanges.of((view) => {
					const value = view.plugin(plugin);
					return value?.atomicRanges ?? Decoration.none;
				}),
		},
	);

	return [Prec.highest(criticMarkupPlugin), criticMarkupTheme];
}

function readPath(view: EditorView): string | null {
	const fileInfo = view.state.field(editorInfoField, false);
	return fileInfo?.file?.path ?? null;
}

function readLivePreview(view: EditorView): boolean {
	return (
		(view.state.field(editorLivePreviewField, false) ?? false) ||
		Boolean(view.dom.closest(".markdown-source-view.is-live-preview"))
	);
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

		const attached = collectAttachedComments(marks, text, index, commentIds);
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
	sourceRanges: Array<[number, number]>,
	ranges: Array<Range<Decoration>>,
	atomRanges: Array<Range<Decoration>>,
): void {
	for (const [from, to] of sourceRanges) {
		addReplace(ranges, from, to);
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

function threadAttributes(
	mark: CriticMark,
	comments: CriticMark[],
): Record<string, string> {
	return {
		"data-critic-from": String(mark.from),
		"data-critic-to": String(mark.to),
		title: comments.map((comment) => comment.content).join("\n"),
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
	const markAttributes = attributes ? { ...attributes } : undefined;
	if (title) {
		if (markAttributes) {
			markAttributes.title = title;
		} else {
			ranges.push(
				Decoration.mark({
					class: className,
					attributes: { title },
				}).range(from, to),
			);
			return;
		}
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
	widget?: WidgetType,
): void {
	if (to <= from) return;
	ranges.push(
		Decoration.replace({
			widget,
			inclusive: false,
		}).range(from, to),
	);
}

function addAtom(ranges: Array<Range<Decoration>>, from: number, to: number): void {
	if (to <= from) return;
	ranges.push(Decoration.mark({}).range(from, to));
}

const criticMarkupTheme = EditorView.baseTheme({
	"&": {
		position: "relative",
	},
	".cm-critic-addition": {
		backgroundColor: "rgba(46, 160, 67, 0.16)",
		borderBottom: "1px solid rgba(46, 160, 67, 0.75)",
	},
	".cm-critic-deletion": {
		backgroundColor: "rgba(218, 54, 51, 0.14)",
		color: "var(--text-muted)",
		textDecoration: "line-through",
		textDecorationThickness: "1.5px",
	},
	".cm-critic-highlight": {
		backgroundColor: "rgba(227, 179, 65, 0.32)",
		borderRadius: "2px",
	},
	".cm-critic-comment-raw": {
		color: "var(--text-accent)",
	},
	".cm-critic-invalid": {
		textDecoration: "underline wavy var(--text-error)",
	},
	".cm-critic-invalid-widget": {
		color: "var(--text-error)",
		borderBottom: "1px wavy var(--text-error)",
	},
});
