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

export function createCriticMarkupExtension(
	controller: CriticMarkupEditorController,
): Extension {
	const criticMarkupPlugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet = Decoration.none;
			private renderVersion = -1;
			private commentButton: HTMLButtonElement;

			constructor(private view: EditorView) {
				this.commentButton = this.createCommentButton();
				this.view.dom.appendChild(this.commentButton);
				this.rebuild();
			}

			update(update: ViewUpdate): void {
				const nextVersion = controller.getRenderVersion();
				if (
					update.docChanged ||
					update.selectionSet ||
					update.viewportChanged ||
					nextVersion !== this.renderVersion
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
				const livePreview =
					this.view.state.field(editorLivePreviewField, false) ?? false;
				const ranges: Array<Range<Decoration>> = [];

				for (const mark of parseCriticMarkup(text)) {
					if (!mark.valid) {
						addMark(ranges, mark.from, mark.to, "cm-critic-invalid", mark.error);
						continue;
					}

					const hideRaw = livePreview;

					if (mode === "clean") {
						this.decorateClean(mark, hideRaw, ranges);
					} else {
						this.decorateReview(mark, hideRaw, ranges);
					}
				}

				ranges.sort((a, b) => a.from - b.from || a.to - b.to);
				this.decorations = Decoration.set(ranges, true);
				this.updateCommentButton();
			}

			private decorateReview(
				mark: CriticMark,
				hideRaw: boolean,
				ranges: Array<Range<Decoration>>,
			): void {
				if (mark.type === "comment" && hideRaw) {
					addReplace(
						ranges,
						mark.from,
						mark.to,
						new TextWidget("Comment", "cm-critic-comment-widget", mark.content),
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
					selection.empty ||
					selectedText.trim().length === 0
				) {
					this.commentButton.removeClass("is-visible");
					return;
				}

				const coords = this.view.coordsAtPos(selection.to);
				if (!coords) {
					this.commentButton.removeClass("is-visible");
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
				this.commentButton.addClass("is-visible");
			}
		},
		{ decorations: (value) => value.decorations },
	);

	return [criticMarkupPlugin, criticMarkupTheme];
}

function readPath(view: EditorView): string | null {
	const fileInfo = view.state.field(editorInfoField, false);
	return fileInfo?.file?.path ?? null;
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
		display: "inline-block",
		padding: "0 6px",
		margin: "0 2px",
		borderRadius: "6px",
		backgroundColor: "var(--background-modifier-hover)",
		color: "var(--text-muted)",
		fontSize: "0.85em",
		border: "1px solid var(--background-modifier-border)",
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
});
