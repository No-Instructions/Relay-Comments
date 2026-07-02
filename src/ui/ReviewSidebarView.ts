import {
	ItemView,
	MarkdownView,
	Menu,
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
	private selectedItemId: string | null = null;
	private replyDraftItemId: string | null = null;
	private pendingAlignmentRange: { from: number; to: number } | null = null;

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
		if (this.pendingAlignmentRange) {
			this.alignSelectedCard(this.pendingAlignmentRange);
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
		const isThreadSelected =
			selected || this.selectedItemId === item.id || this.replyDraftItemId === item.id;
		const card = parent.createDiv({
			cls: isThreadSelected
				? "critic-card critic-card-selected"
				: "critic-card",
			attr: {
				tabindex: "0",
				role: "button",
				"data-critic-item-id": item.id,
			},
		});
		card.addEventListener("click", (event) => {
			if ((event.target as HTMLElement).closest("button, textarea, input, a")) {
				return;
			}
			this.locateItem(item);
		});
		card.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			this.locateItem(item);
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

		if (item.kind === "anchored-comment") {
			this.addOverflowMenu(header, item);
		} else if (isSuggestion(item.mark)) {
			this.addSuggestionActions(header, item.mark);
		} else {
			this.addOverflowMenu(header, item);
		}

		if (item.kind === "anchored-comment") {
			card.createDiv({ cls: "critic-card-quote", text: item.anchor.content });
			card.createDiv({ cls: "critic-card-body", text: item.comment.content });
			this.renderReplyComposer(card, item, item.comment, isThreadSelected);
			return;
		}

		this.renderMarkBody(card, item.mark);
		if (item.mark.type === "comment") {
			this.renderReplyComposer(card, item, item.mark, isThreadSelected);
		}
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

	private addSuggestionActions(parent: HTMLElement, mark: CriticMark): void {
		const actions = parent.createDiv({ cls: "critic-suggestion-actions" });
		this.addActionChip(actions, "Accept", () => this.applyMark(mark, "accept"));
		this.addActionChip(actions, "Reject", () => this.applyMark(mark, "reject"));
	}

	private addOverflowMenu(parent: HTMLElement, item: ReviewItem): void {
		const button = parent.createEl("button", {
			cls: "critic-icon-button",
			attr: { "aria-label": "More actions", title: "More actions" },
		});
		setIcon(button, "more-horizontal");
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			const menu = new Menu();
			if (isCommentItem(item)) {
				menu.addItem((menuItem) => {
					menuItem
						.setTitle("Reply")
						.setIcon("reply")
						.onClick(() => {
							this.replyDraftItemId = item.id;
							this.render();
						});
				});
			}
			menu.addItem((menuItem) => {
				menuItem
					.setTitle("Resolve")
					.setIcon("check")
					.onClick(() => this.resolveReviewItem(item));
			});
			menu.showAtMouseEvent(event);
		});
	}

	private addActionChip(
		parent: HTMLElement,
		label: string,
		callback: () => void,
	): void {
		const button = parent.createEl("button", {
			cls: "critic-action-chip",
			text: label,
		});
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			callback();
		});
	}

	private addTextButton(
		parent: HTMLElement,
		label: string,
		callback: () => void,
	): void {
		const button = parent.createEl("button", { text: label });
		button.addClass("critic-text-button");
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			callback();
		});
	}

	private locateItem(item: ReviewItem): void {
		this.selectedItemId = item.id;
		this.replyDraftItemId = isCommentItem(item) ? item.id : null;
		const range = getItemTargetRange(item);
		this.pendingAlignmentRange = range;
		this.plugin.locateReviewRange(range.from, range.to, {
			focusEditor: false,
			select: false,
		});
		this.render();
	}

	private alignSelectedCard(range: { from: number; to: number }): void {
		const selectedItemId = this.selectedItemId;
		if (!selectedItemId) return;
		window.requestAnimationFrame(() => {
			if (this.selectedItemId !== selectedItemId) return;
			const card = Array.from(
				this.contentEl.querySelectorAll<HTMLElement>(".critic-card"),
			).find((candidate) => candidate.dataset.criticItemId === selectedItemId);
			const anchorRect = this.plugin.getReviewRangeClientRect(range.from, range.to);
			if (!card || !anchorRect) return;

			card.style.marginTop = "0";
			const cardRect = card.getBoundingClientRect();
			const targetTop = Math.max(anchorRect.top, this.contentEl.getBoundingClientRect().top);
			const marginTop = Math.max(0, Math.round(targetTop - cardRect.top));
			card.style.marginTop = marginTop > 0 ? `${marginTop}px` : "";
		});
	}

	private renderReplyComposer(
		card: HTMLElement,
		item: ReviewItem,
		mark: CriticMark,
		selected: boolean,
	): void {
		if (!selected) {
			return;
		}

		const composer = card.createDiv({ cls: "critic-thread-composer" });
		const textarea = composer.createEl("textarea", {
			cls: "critic-thread-textarea",
			attr: { placeholder: "Reply to this thread..." },
		});
		textarea.addEventListener("click", (event) => event.stopPropagation());
		textarea.addEventListener("keydown", (event) => {
			if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
			event.preventDefault();
			this.commitThreadReply(mark, textarea);
		});
		const actions = composer.createDiv({ cls: "critic-composer-actions" });
		this.addTextButton(actions, "Cancel", () => {
			this.replyDraftItemId = null;
			this.render();
		});
		this.addTextButton(actions, "Reply", () => this.commitThreadReply(mark, textarea));
		setTimeout(() => textarea.focus(), 0);
	}

	private commitThreadReply(mark: CriticMark, textarea: HTMLTextAreaElement): void {
		const value = textarea.value.trim();
		if (value.length === 0) return;
		void this.plugin.insertReplyToMark(mark, value);
		this.replyDraftItemId = null;
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

	private resolveReviewItem(item: ReviewItem): void {
		if (item.kind === "anchored-comment") {
			this.resolveItem(item);
		} else {
			this.applyMark(item.mark, "accept");
		}
	}

	private applyMark(mark: CriticMark, action: CriticAction): void {
		this.plugin.applyMarkActionFromSidebar(mark, action);
		this.render();
	}
}

function isCommentItem(item: ReviewItem): boolean {
	return (
		item.kind === "anchored-comment" ||
		(item.kind === "mark" && item.mark.type === "comment")
	);
}

function getItemTargetRange(item: ReviewItem): { from: number; to: number } {
	if (item.kind === "anchored-comment") {
		return { from: item.anchor.from, to: item.anchor.to };
	}
	return { from: item.mark.from, to: item.mark.to };
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
