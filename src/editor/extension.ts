import { editorInfoField, editorLivePreviewField, setIcon } from "obsidian";
import type { Extension, Range } from "@codemirror/state";
import {
	Decoration,
	EditorView,
	ViewPlugin,
	type DecorationSet,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { parseCriticMarkup } from "../critic/parse";
import type { CriticMark, DisplayMode } from "../critic/types";

export interface CriticMarkupEditorController {
	getDisplayMode(path?: string | null): DisplayMode;
	getRenderVersion(): number;
	shouldShowInlineActions(): boolean;
	startCommentDraft(
		path: string | null,
		from: number,
		to: number,
		selectedText: string,
	): void;
}

class TextWidget extends WidgetType {
	constructor(
		private text: string,
		private className: string,
		private title?: string,
	) {
		super();
	}

	toDOM(view: EditorView): HTMLElement {
		const span = view.dom.ownerDocument.createElement("span");
		span.className = this.className;
		span.textContent = this.text;
		if (this.title) span.title = this.title;
		return span;
	}

	eq(other: TextWidget): boolean {
		return (
			this.text === other.text &&
			this.className === other.className &&
			this.title === other.title
		);
	}
}

class CommentMarkerWidget extends WidgetType {
	constructor(private title: string) {
		super();
	}

	toDOM(view: EditorView): HTMLElement {
		const span = view.dom.ownerDocument.createElement("span");
		span.className = "cm-critic-comment-widget";
		span.title = this.title;
		setIcon(span, "message-square");
		return span;
	}

	eq(other: CommentMarkerWidget): boolean {
		return this.title === other.title;
	}
}

class MarkPreviewWidget extends WidgetType {
	constructor(
		private mark: CriticMark,
		private mode: DisplayMode,
		private anchoredComment: boolean,
	) {
		super();
	}

	toDOM(view: EditorView): HTMLElement {
		const span = view.dom.ownerDocument.createElement("span");
		span.className = `cm-critic-preview cm-critic-preview-${this.mark.type}`;
		switch (this.mark.type) {
			case "addition":
				span.textContent = this.mark.content;
				if (this.mode === "review") span.classList.add("cm-critic-addition");
				break;
			case "deletion":
				if (this.mode === "review") {
					span.classList.add("cm-critic-deletion");
					span.textContent = this.mark.content;
				}
				break;
			case "substitution":
				if (this.mode === "clean") {
					span.textContent = this.mark.newText ?? "";
				} else {
					const oldText = span.createEl("span", {
						cls: "cm-critic-deletion",
						text: this.mark.oldText ?? "",
					});
					oldText.addClass("cm-critic-substitution-part");
					span.createEl("span", {
						cls: "cm-critic-substitution-arrow",
						text: " -> ",
					});
					const newText = span.createEl("span", {
						cls: "cm-critic-addition",
						text: this.mark.newText ?? "",
					});
					newText.addClass("cm-critic-substitution-part");
				}
				break;
			case "comment":
				if (this.mode === "review" && !this.anchoredComment) {
					span.className = "cm-critic-comment-widget";
					span.title = this.mark.content;
					setIcon(span, "message-square");
				}
				break;
			case "highlight":
				span.textContent = this.mark.content;
				if (this.mode === "review") span.classList.add("cm-critic-highlight");
				break;
		}
		return span;
	}

	eq(other: MarkPreviewWidget): boolean {
		return (
			this.mark.id === other.mark.id &&
			this.mark.raw === other.mark.raw &&
			this.mode === other.mode &&
			this.anchoredComment === other.anchoredComment
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
			private path: string | null = null;
			private mode: DisplayMode = "review";
			private livePreview = false;

			constructor(private view: EditorView) {
				this.commentButton = this.createCommentButton();
				this.view.dom.appendChild(this.commentButton);
				this.rebuild();
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
					this.rebuild();
				} else {
					this.updateCommentButton();
				}
			}

			destroy(): void {
				this.commentButton.remove();
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
				const anchoredCommentIds = findAnchoredCommentIds(marks);

				for (const mark of marks) {
					if (!mark.valid) {
						if (livePreview) {
							addReplace(
								ranges,
								mark.from,
								mark.to,
								new TextWidget(
									"Invalid CriticMarkup",
									"cm-critic-invalid-widget",
									mark.error,
								),
							);
							addAtom(atomRanges, mark.from, mark.to);
							continue;
						}
						addMark(ranges, mark.from, mark.to, "cm-critic-invalid", mark.error);
						continue;
					}

					if (livePreview) {
						addReplace(
							ranges,
							mark.from,
							mark.to,
							new MarkPreviewWidget(
								mark,
								mode,
								anchoredCommentIds.has(mark.id),
							),
						);
						addAtom(atomRanges, mark.from, mark.to);
						continue;
					}

					if (mode === "clean") {
						this.decorateClean(mark, false, ranges);
					} else {
						this.decorateReview(mark, false, ranges, anchoredCommentIds);
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
			): void {
				if (mark.type === "comment" && hideRaw) {
					if (anchoredCommentIds.has(mark.id)) {
						addReplace(ranges, mark.from, mark.to);
						return;
					}
					addReplace(
						ranges,
						mark.from,
						mark.to,
						new CommentMarkerWidget(mark.content),
					);
					return;
				}

				if (hideRaw) hideDelimiters(mark, ranges);

				switch (mark.type) {
					case "addition":
						addMark(ranges, mark.contentFrom, mark.contentTo, "cm-critic-addition");
						break;
					case "deletion":
						addMark(ranges, mark.contentFrom, mark.contentTo, "cm-critic-deletion");
						break;
					case "substitution":
						if (hideRaw && mark.ranges.separator) {
							addReplace(
								ranges,
								mark.ranges.separator[0],
								mark.ranges.separator[1],
								new TextWidget(" -> ", "cm-critic-substitution-arrow"),
							);
						}
						if (mark.ranges.oldText) {
							addMark(
								ranges,
								mark.ranges.oldText[0],
								mark.ranges.oldText[1],
								"cm-critic-deletion",
							);
						}
						if (mark.ranges.newText) {
							addMark(
								ranges,
								mark.ranges.newText[0],
								mark.ranges.newText[1],
								"cm-critic-addition",
							);
						}
						break;
					case "comment":
						addMark(ranges, mark.from, mark.to, "cm-critic-comment-raw");
						break;
					case "highlight":
						addMark(ranges, mark.contentFrom, mark.contentTo, "cm-critic-highlight");
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
					case "comment":
						addReplace(ranges, mark.from, mark.to);
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

	return [criticMarkupPlugin, criticMarkupTheme];
}

function readPath(view: EditorView): string | null {
	const fileInfo = view.state.field(editorInfoField, false);
	return fileInfo?.file?.path ?? null;
}

function readLivePreview(view: EditorView): boolean {
	return view.state.field(editorLivePreviewField, false) ?? false;
}

function findAnchoredCommentIds(marks: CriticMark[]): Set<string> {
	const ids = new Set<string>();
	for (let index = 0; index < marks.length; index += 1) {
		const mark = marks[index];
		if (!mark.valid || mark.type !== "highlight") continue;
		const comment = marks.find(
			(candidate, candidateIndex) =>
				candidateIndex > index &&
				candidate.valid &&
				candidate.type === "comment" &&
				candidate.from === mark.to,
		);
		if (comment) ids.add(comment.id);
	}
	return ids;
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

function addMark(
	ranges: Array<Range<Decoration>>,
	from: number,
	to: number,
	className: string,
	title?: string,
): void {
	if (to <= from) return;
	ranges.push(
		Decoration.mark({
			class: className,
			attributes: title ? { title } : undefined,
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
	".cm-critic-comment-widget": {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		width: "18px",
		height: "18px",
		padding: "0",
		margin: "0 2px",
		borderRadius: "50%",
		backgroundColor: "var(--background-modifier-hover)",
		color: "var(--text-muted)",
		border: "1px solid var(--background-modifier-border)",
		verticalAlign: "text-bottom",
	},
	".cm-critic-comment-widget svg": {
		width: "12px",
		height: "12px",
	},
	".cm-critic-comment-raw": {
		color: "var(--text-accent)",
	},
	".cm-critic-substitution-arrow": {
		color: "var(--text-muted)",
		padding: "0 3px",
	},
	".cm-critic-invalid": {
		textDecoration: "underline wavy var(--text-error)",
	},
	".cm-critic-invalid-widget": {
		color: "var(--text-error)",
		borderBottom: "1px wavy var(--text-error)",
	},
});
