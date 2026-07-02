import {
	ItemView,
	MarkdownView,
	setIcon,
	type IconName,
	type WorkspaceLeaf,
} from "obsidian";
import { getMarkSummary, getMarkTitle } from "../critic/render";
import type { CriticAction } from "../critic/transform";
import type { CriticMark, CriticMarkType } from "../critic/types";
import type CriticMarkupPlugin from "../main";

export const VIEW_TYPE_CRITIC_REVIEW = "criticmarkup-review-sidebar";

type ReviewItem =
	| {
			kind: "anchored-comment";
			id: string;
			type: "comment";
			anchor: CriticMark;
			comment: CriticMark;
			from: number;
			to: number;
			line: number;
	  }
	| {
			kind: "mark";
			id: string;
			type: CriticMarkType;
			mark: CriticMark;
			from: number;
			to: number;
			line: number;
	  };

export class ReviewSidebarView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private plugin: CriticMarkupPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CRITIC_REVIEW;
	}

	getDisplayText(): string {
		return "CriticMarkup Review";
	}

	getIcon(): IconName {
		return "message-square-text";
	}

	protected async onOpen(): Promise<void> {
		this.render();
	}

	refresh(): void {
		this.render();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("critic-sidebar");

		const state = this.plugin.getActiveReviewState();
		if (!state) {
			root.createEl("div", {
				cls: "critic-sidebar-empty",
				text: "Open a Markdown note to review CriticMarkup.",
			});
			return;
		}

		const header = root.createDiv({ cls: "critic-sidebar-header" });
		header.createEl("h3", { text: state.file.basename });
		const modeButton = header.createEl("button", {
			cls: "critic-sidebar-mode",
			text: formatMode(state.displayMode),
		});
		modeButton.title = "Switch display mode for this note";
		modeButton.addEventListener("click", () => {
			void this.plugin.toggleCurrentNoteDisplayMode();
		});

		const validMarks = state.marks
			.filter((mark) => mark.valid)
			.sort((a, b) => a.from - b.from || a.to - b.to);
		const items = buildReviewItems(validMarks);
		root.createDiv({
			cls: "critic-sidebar-counts",
			text: formatCounts(items),
		});

		if (state.commentDraft) {
			this.renderDraft(root, state.commentDraft.selectedText);
		}

		if (items.length === 0) {
			root.createEl("div", {
				cls: "critic-sidebar-empty",
				text: "No comments or suggestions in this note.",
			});
			return;
		}

		const list = root.createDiv({ cls: "critic-sidebar-list" });
		for (const item of items) {
			this.renderItem(list, item, isSelected(item, state.activeMarkId));
		}
	}

	private renderDraft(parent: HTMLElement, selectedText: string): void {
		const card = parent.createDiv({ cls: "critic-card critic-draft-card" });
		const header = card.createDiv({ cls: "critic-card-header" });
		const identity = header.createDiv({ cls: "critic-card-identity" });
		identity.createDiv({ cls: "critic-avatar", text: "+" });
		const meta = identity.createDiv({ cls: "critic-card-meta" });
		meta.createDiv({ cls: "critic-card-author", text: "New comment" });
		meta.createDiv({ cls: "critic-card-location", text: "Draft" });

		if (selectedText.length > 0) {
			card.createDiv({ cls: "critic-card-quote", text: selectedText });
		}
		const textarea = card.createEl("textarea", {
			cls: "critic-draft-textarea",
			attr: { placeholder: "Write a comment..." },
		});
		const actions = card.createDiv({ cls: "critic-draft-actions" });
		this.addTextButton(actions, "Cancel", () => this.plugin.cancelCommentDraft());
		this.addTextButton(actions, "Comment", () => {
			const value = textarea.value.trim();
			if (value.length === 0) return;
			this.plugin.commitCommentDraft(value);
		});
		setTimeout(() => textarea.focus(), 0);
	}

	private renderItem(
		parent: HTMLElement,
		item: ReviewItem,
		selected: boolean,
	): void {
		const card = parent.createDiv({
			cls: selected ? "critic-card critic-card-selected" : "critic-card",
		});

		const header = card.createDiv({ cls: "critic-card-header" });
		const identity = header.createDiv({ cls: "critic-card-identity" });
		const author = getItemAuthor(item);
		identity.createDiv({ cls: "critic-avatar", text: initials(author) });
		const meta = identity.createDiv({ cls: "critic-card-meta" });
		meta.createDiv({ cls: "critic-card-author", text: author });
		meta.createDiv({
			cls: "critic-card-location",
			text: `${getItemLabel(item)} · Line ${item.line + 1}`,
		});

		const actions = header.createDiv({ cls: "critic-card-icon-actions" });
		this.addIconButton(actions, "Locate in note", "locate-fixed", () =>
			this.locateItem(item),
		);

		if (item.kind === "anchored-comment") {
			this.addIconButton(actions, "Reply", "reply", () => {
				void this.plugin.replyToMark(item.comment);
			});
			this.addIconButton(actions, "Resolve comment", "check", () =>
				this.resolveItem(item),
			);
		} else if (isSuggestion(item.mark)) {
			this.addIconButton(actions, "Accept suggestion", "check", () =>
				this.applyMark(item.mark, "accept"),
			);
			this.addIconButton(actions, "Reject suggestion", "x", () =>
				this.applyMark(item.mark, "reject"),
			);
		} else {
			if (item.mark.type === "comment") {
				this.addIconButton(actions, "Reply", "reply", () => {
					void this.plugin.replyToMark(item.mark);
				});
			}
			this.addIconButton(actions, "Resolve", "check", () =>
				this.applyMark(item.mark, "accept"),
			);
		}

		if (item.kind === "anchored-comment") {
			card.createDiv({ cls: "critic-card-quote", text: item.anchor.content });
			card.createDiv({ cls: "critic-card-body", text: item.comment.content });
			return;
		}

		this.renderMarkBody(card, item.mark);
	}

	private renderMarkBody(card: HTMLElement, mark: CriticMark): void {
		if (mark.type === "highlight") {
			card.createDiv({ cls: "critic-card-quote", text: mark.content });
			return;
		}

		const body = card.createDiv({ cls: "critic-card-body" });
		if (mark.type === "substitution") {
			const oldText = body.createEl("del", { text: mark.oldText ?? "" });
			oldText.addClass("critic-card-old");
			body.createSpan({ cls: "critic-card-arrow", text: " -> " });
			const newText = body.createEl("ins", { text: mark.newText ?? "" });
			newText.addClass("critic-card-new");
		} else {
			body.setText(getMarkSummary(mark));
		}
	}

	private addIconButton(
		parent: HTMLElement,
		label: string,
		icon: string,
		callback: () => void,
	): void {
		const button = parent.createEl("button", {
			cls: "critic-icon-button",
			attr: { "aria-label": label, title: label },
		});
		setIcon(button, icon);
		button.addEventListener("click", callback);
	}

	private addTextButton(
		parent: HTMLElement,
		label: string,
		callback: () => void,
	): void {
		const button = parent.createEl("button", { text: label });
		button.addEventListener("click", callback);
	}

	private locateItem(item: ReviewItem): void {
		this.plugin.locateReviewRange(item.from, item.to);
	}

	private resolveItem(
		item: Extract<ReviewItem, { kind: "anchored-comment" }>,
	): void {
		this.plugin.replaceReviewRangeFromSidebar(
			item.from,
			item.to,
			item.anchor.content,
		);
		this.render();
	}

	private applyMark(mark: CriticMark, action: CriticAction): void {
		this.plugin.applyMarkActionFromSidebar(mark, action);
		this.render();
	}
}

function buildReviewItems(marks: CriticMark[]): ReviewItem[] {
	const items: ReviewItem[] = [];
	const consumed = new Set<string>();

	for (let index = 0; index < marks.length; index += 1) {
		const mark = marks[index];
		if (consumed.has(mark.id)) continue;

		if (mark.type === "highlight") {
			const comment = marks.find(
				(candidate, candidateIndex) =>
					candidateIndex > index &&
					!consumed.has(candidate.id) &&
					candidate.type === "comment" &&
					candidate.from === mark.to,
			);
			if (comment) {
				consumed.add(mark.id);
				consumed.add(comment.id);
				items.push({
					kind: "anchored-comment",
					id: `${mark.id}:${comment.id}`,
					type: "comment",
					anchor: mark,
					comment,
					from: mark.from,
					to: comment.to,
					line: mark.line,
				});
				continue;
			}
		}

		consumed.add(mark.id);
		items.push({
			kind: "mark",
			id: mark.id,
			type: mark.type,
			mark,
			from: mark.from,
			to: mark.to,
			line: mark.line,
		});
	}

	return items;
}

function isSelected(item: ReviewItem, activeMarkId: string | null): boolean {
	if (!activeMarkId) return false;
	if (item.kind === "anchored-comment") {
		return item.anchor.id === activeMarkId || item.comment.id === activeMarkId;
	}
	return item.mark.id === activeMarkId;
}

function isSuggestion(mark: CriticMark): boolean {
	return (
		mark.type === "addition" ||
		mark.type === "deletion" ||
		mark.type === "substitution"
	);
}

function formatCounts(items: ReviewItem[]): string {
	const comments = items.filter((item) => item.type === "comment").length;
	const suggestions = items.filter(
		(item) => item.kind === "mark" && isSuggestion(item.mark),
	).length;
	const highlights = items.filter((item) => item.type === "highlight").length;
	const parts: string[] = [];
	if (comments > 0) parts.push(`${comments} ${comments === 1 ? "comment" : "comments"}`);
	if (suggestions > 0) {
		parts.push(`${suggestions} ${suggestions === 1 ? "suggestion" : "suggestions"}`);
	}
	if (highlights > 0) {
		parts.push(`${highlights} ${highlights === 1 ? "highlight" : "highlights"}`);
	}
	return parts.length > 0 ? parts.join(" · ") : "No comments or suggestions";
}

function getItemAuthor(item: ReviewItem): string {
	const mark = item.kind === "anchored-comment" ? item.comment : item.mark;
	return mark.metadata?.author ?? "Reviewer";
}

function getItemLabel(item: ReviewItem): string {
	if (item.kind === "anchored-comment") return "Comment";
	return getMarkTitle(item.mark);
}

function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "?";
	return words
		.slice(0, 2)
		.map((word) => word[0]?.toUpperCase() ?? "")
		.join("");
}

export function getActiveMarkdownView(plugin: CriticMarkupPlugin): MarkdownView | null {
	return plugin.app.workspace.getActiveViewOfType(MarkdownView);
}

function formatMode(mode: string): string {
	switch (mode) {
		case "review":
			return "Review";
		case "clean":
			return "Clean";
		case "raw":
			return "Raw";
		default:
			return "Review";
	}
}
