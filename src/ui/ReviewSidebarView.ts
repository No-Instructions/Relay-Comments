import {
	ItemView,
	MarkdownView,
	Menu,
	setIcon,
	type IconName,
	type WorkspaceLeaf,
} from "obsidian";
import { getMarkSummary, getMarkTitle } from "../critic/render";
import { replacementForMark, type CriticAction } from "../critic/transform";
import type { CriticMark, CriticMarkType } from "../critic/types";
import type CriticMarkupPlugin from "../main";
import type { ReviewerIdentity } from "../main";

export const VIEW_TYPE_CRITIC_REVIEW = "criticmarkup-review-sidebar";

type ReviewItem =
	| {
			kind: "anchored-comment";
			id: string;
			type: CriticMarkType;
			anchor: CriticMark;
			comment: CriticMark;
			comments: CriticMark[];
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

interface CommentHeaderOptions {
	identity: ReviewerIdentity;
	mark?: CriticMark;
	label?: string;
	actionItem?: ReviewItem;
	onEdit?: () => void;
}

export class ReviewSidebarView extends ItemView {
	private selectedItemId: string | null = null;
	private replyDraftItemId: string | null = null;
	private editingCommentId: string | null = null;
	private replyDrafts = new Map<string, string>();
	private editDrafts = new Map<string, string>();
	private removeOutsideClickListener: (() => void) | null = null;

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
		this.installOutsideClickListener();
		this.render();
	}

	protected async onClose(): Promise<void> {
		this.removeOutsideClickListener?.();
		this.removeOutsideClickListener = null;
	}

	refresh(): void {
		this.render();
	}

	activateThreadForRange(from: number, to: number): void {
		const state = this.plugin.getActiveReviewState();
		if (!state) return;

		const validMarks = state.marks
			.filter((mark) => mark.valid)
			.sort((a, b) => a.from - b.from || a.to - b.to);
		const item = buildReviewItems(validMarks).find(
			(candidate) =>
				candidate.kind === "anchored-comment" &&
				candidate.anchor.from === from &&
				candidate.anchor.to === to,
		);
		if (!item) return;

		this.selectedItemId = item.id;
		this.replyDraftItemId = item.id;
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
			this.renderItem(list, item, isSelected(item, state.activeMarkId), state.file.path);
		}
	}

	private installOutsideClickListener(): void {
		if (this.removeOutsideClickListener) return;
		const handler = (event: MouseEvent) => {
			if (!this.selectedItemId && !this.replyDraftItemId && !this.editingCommentId) return;
			const target = event.target as HTMLElement | null;
			if (!target) return;
			if (this.contentEl.contains(target)) {
				const clickedCard = target.closest(".critic-card");
				if (clickedCard && this.contentEl.contains(clickedCard)) return;
			}
			if (
				target.closest(
					".cm-critic-thread-anchor, .cm-critic-anchored-comment, .cm-critic-preview",
				)
			) {
				return;
			}

			this.selectedItemId = null;
			this.replyDraftItemId = null;
			this.editingCommentId = null;
			this.render();
		};
		document.addEventListener("mousedown", handler, true);
		this.removeOutsideClickListener = () => {
			document.removeEventListener("mousedown", handler, true);
		};
	}

	private renderDraft(parent: HTMLElement, selectedText: string): void {
		const card = parent.createDiv({ cls: "critic-card critic-draft-card" });
		this.renderCommentHeader(card, {
			identity: this.plugin.getCurrentReviewerIdentity(),
			label: "Draft",
		});

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
		filePath: string,
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

		if (item.kind === "anchored-comment") {
			this.renderAnchoredThread(card, item, isThreadSelected, filePath);
			return;
		}

		const author = this.getItemIdentity(item, filePath);
		const editing = item.mark.type === "comment" && this.editingCommentId === item.mark.id;
		this.renderCommentHeader(card, {
			identity: author,
			mark: item.mark,
			label: item.mark.type === "comment" ? undefined : getItemLabel(item),
			actionItem: isThreadSelected ? item : undefined,
		});

		if (editing && item.mark.type === "comment") {
			this.renderCommentEditor(card, item, item.mark);
		} else {
			this.renderMarkBody(card, item.mark);
		}
		if (item.mark.type === "comment" && !editing) {
			this.renderReplyComposer(card, item, item.mark, isThreadSelected);
		}
	}

	private renderAnchoredThread(
		card: HTMLElement,
		item: Extract<ReviewItem, { kind: "anchored-comment" }>,
		selected: boolean,
		filePath: string,
	): void {
		card.createDiv({
			cls: "critic-thread-summary",
			text: formatThreadSummary(item),
		});
		if (selected) {
			const toolbar = card.createDiv({ cls: "critic-thread-toolbar" });
			this.addCardActions(toolbar, item);
		}
		this.renderThreadMessages(card, item.comments, filePath, item);
		if (!this.isEditingInItem(item)) {
			this.renderReplyComposer(
				card,
				item,
				item.comments[item.comments.length - 1] ?? item.comment,
				selected,
			);
		}
	}

	private renderThreadMessages(
		card: HTMLElement,
		comments: CriticMark[],
		filePath: string,
		item: ReviewItem,
	): void {
		const thread = card.createDiv({ cls: "critic-thread-messages" });
		for (const comment of comments) {
			this.renderThreadMessage(thread, comment, filePath, item);
		}
	}

	private renderThreadMessage(
		parent: HTMLElement,
		comment: CriticMark,
		filePath: string,
		item: ReviewItem,
	): void {
		const author = this.plugin.getReviewerIdentityForMark(comment, filePath);
		const message = parent.createDiv({ cls: "critic-thread-message" });
		this.renderCommentHeader(message, {
			identity: author,
			mark: comment,
			onEdit: () => this.startEditingComment(comment, item),
		});
		if (this.editingCommentId === comment.id) {
			this.renderCommentEditor(message, item, comment);
		} else {
			message.createDiv({ cls: "critic-message-text", text: comment.content });
		}
	}

	private renderCommentHeader(
		parent: HTMLElement,
		options: CommentHeaderOptions,
	): void {
		const header = parent.createDiv({ cls: "critic-comment-header" });
		const identity = header.createDiv({ cls: "critic-comment-identity" });
		this.renderAvatar(identity, options.identity);
		const meta = identity.createDiv({ cls: "critic-comment-meta" });
		const byline = meta.createDiv({ cls: "critic-comment-byline" });
		byline.createSpan({ cls: "critic-comment-author", text: options.identity.name });
		const date = options.mark ? formatMarkDate(options.mark) : null;
		if (date) {
			byline.createSpan({ cls: "critic-comment-date", text: date });
		}
		if (options.label) {
			meta.createDiv({ cls: "critic-comment-subtitle", text: options.label });
		}
		if (options.actionItem) {
			this.addCardActions(header, options.actionItem);
		} else if (options.onEdit) {
			this.addCommentActions(header, options.onEdit);
		}
	}

	private renderAvatar(parent: HTMLElement, identity: ReviewerIdentity): void {
		if (identity.picture) {
			parent.createEl("img", {
				cls: "critic-avatar critic-avatar-image",
				attr: {
					src: identity.picture,
					alt: "",
				},
			});
			return;
		}

		const avatar = parent.createDiv({
			cls: "critic-avatar",
			text: initials(identity.name),
		});
		if (identity.color) {
			avatar.style.backgroundColor = identity.color;
		}
	}

	private getItemIdentity(item: ReviewItem, filePath: string): ReviewerIdentity {
		const mark = item.kind === "anchored-comment" ? item.comment : item.mark;
		return this.plugin.getReviewerIdentityForMark(mark, filePath);
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
			const newText = body.createEl("ins", { text: mark.newText ?? "" });
			newText.addClass("critic-card-new");
		} else {
			body.setText(getMarkSummary(mark));
		}
	}

	private addCardActions(parent: HTMLElement, item: ReviewItem): void {
		const actions = parent.createDiv({ cls: "critic-card-actions" });
		this.addResolveButton(actions, item);
		if (itemHasSecondaryActions(item)) {
			this.addOverflowMenu(actions, item);
		}
	}

	private addResolveButton(parent: HTMLElement, item: ReviewItem): void {
		const button = parent.createEl("button", {
			cls: "critic-icon-button critic-check-button",
			attr: { "aria-label": "Resolve", title: "Resolve" },
		});
		setIcon(button, "check");
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			this.resolveReviewItem(item);
		});
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
			if (item.kind === "anchored-comment" && isSuggestion(item.anchor)) {
				menu.addItem((menuItem) => {
					menuItem
						.setTitle("Accept suggestion")
						.setIcon("check")
						.onClick(() => this.applyThreadSuggestionAction(item, "accept"));
				});
				menu.addItem((menuItem) => {
					menuItem
						.setTitle("Reject suggestion")
						.setIcon("x")
						.onClick(() => this.applyThreadSuggestionAction(item, "reject"));
				});
				menu.addSeparator();
			}
			if (item.kind === "mark" && isSuggestion(item.mark)) {
				menu.addItem((menuItem) => {
					menuItem
						.setTitle("Accept suggestion")
						.setIcon("check")
						.onClick(() => this.applyMark(item.mark, "accept"));
				});
				menu.addItem((menuItem) => {
					menuItem
						.setTitle("Reject suggestion")
						.setIcon("x")
						.onClick(() => this.applyMark(item.mark, "reject"));
				});
			}
			if (item.kind === "mark" && item.mark.type === "comment") {
				menu.addItem((menuItem) => {
					menuItem
						.setTitle("Edit")
						.setIcon("pencil")
						.onClick(() => this.startEditingComment(item.mark, item));
				});
			}
			menu.showAtMouseEvent(event);
		});
	}

	private addCommentActions(parent: HTMLElement, onEdit: () => void): void {
		const actions = parent.createDiv({
			cls: "critic-card-actions critic-message-actions",
		});
		const button = actions.createEl("button", {
			cls: "critic-icon-button",
			attr: { "aria-label": "More actions", title: "More actions" },
		});
		setIcon(button, "more-horizontal");
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			const menu = new Menu();
			menu.addItem((menuItem) => {
				menuItem.setTitle("Edit").setIcon("pencil").onClick(onEdit);
			});
			menu.showAtMouseEvent(event);
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
		if (this.editingCommentId && !itemContainsComment(item, this.editingCommentId)) {
			this.editingCommentId = null;
		}
		this.selectedItemId = item.id;
		this.replyDraftItemId = isCommentItem(item) ? item.id : null;
		const range = getItemTargetRange(item);
		this.plugin.locateReviewRange(range.from, range.to, {
			focusEditor: false,
			select: false,
		});
		this.render();
	}

	private isEditingInItem(item: ReviewItem): boolean {
		return Boolean(this.editingCommentId && itemContainsComment(item, this.editingCommentId));
	}

	private startEditingComment(comment: CriticMark, item: ReviewItem): void {
		this.selectedItemId = item.id;
		this.replyDraftItemId = null;
		this.editingCommentId = comment.id;
		this.editDrafts.set(comment.id, this.editDrafts.get(comment.id) ?? comment.content);
		const range = getItemTargetRange(item);
		this.plugin.locateReviewRange(range.from, range.to, {
			focusEditor: false,
			select: false,
		});
		this.render();
	}

	private renderCommentEditor(
		parent: HTMLElement,
		item: ReviewItem,
		comment: CriticMark,
	): void {
		const editor = parent.createDiv({ cls: "critic-edit-composer" });
		const textarea = editor.createEl("textarea", {
			cls: "critic-edit-textarea",
			attr: { placeholder: "Edit comment..." },
		});
		textarea.value = this.editDrafts.get(comment.id) ?? comment.content;
		textarea.addEventListener("click", (event) => event.stopPropagation());
		textarea.addEventListener("input", () => {
			this.editDrafts.set(comment.id, textarea.value);
		});
		textarea.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.cancelEditingComment(comment.id);
				return;
			}
			if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
			event.preventDefault();
			this.commitCommentEdit(item, comment, textarea);
		});
		const actions = editor.createDiv({ cls: "critic-edit-actions" });
		this.addTextButton(actions, "Cancel", () => this.cancelEditingComment(comment.id));
		this.addTextButton(actions, "Save", () =>
			this.commitCommentEdit(item, comment, textarea),
		);
		setTimeout(() => {
			textarea.focus();
			const end = textarea.value.length;
			textarea.setSelectionRange(end, end);
		}, 0);
	}

	private cancelEditingComment(commentId: string): void {
		this.editDrafts.delete(commentId);
		if (this.editingCommentId === commentId) {
			this.editingCommentId = null;
		}
		this.render();
	}

	private commitCommentEdit(
		item: ReviewItem,
		comment: CriticMark,
		textarea: HTMLTextAreaElement,
	): void {
		const value = textarea.value.trim();
		if (value.length === 0) return;
		const previousValue = textarea.value;
		textarea.value = "";
		this.editDrafts.delete(comment.id);
		this.editingCommentId = null;
		if (!this.plugin.updateCommentTextFromSidebar(comment, value)) {
			textarea.value = previousValue;
			this.editDrafts.set(comment.id, previousValue);
			this.editingCommentId = comment.id;
			this.selectedItemId = item.id;
			return;
		}
		this.selectedItemId = item.id;
		this.render();
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
		textarea.value = this.replyDrafts.get(item.id) ?? "";
		textarea.addEventListener("click", (event) => event.stopPropagation());
		textarea.addEventListener("input", () => {
			this.replyDrafts.set(item.id, textarea.value);
		});
		textarea.addEventListener("keydown", (event) => {
			if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
			event.preventDefault();
			this.commitThreadReply(item, mark, textarea);
		});
		const actions = composer.createDiv({ cls: "critic-composer-actions" });
		this.addTextButton(actions, "Cancel", () => {
			this.replyDrafts.delete(item.id);
			this.replyDraftItemId = null;
			this.render();
		});
		this.addTextButton(actions, "Reply", () => this.commitThreadReply(item, mark, textarea));
		setTimeout(() => {
			textarea.focus();
			const end = textarea.value.length;
			textarea.setSelectionRange(end, end);
		}, 0);
	}

	private commitThreadReply(
		item: ReviewItem,
		mark: CriticMark,
		textarea: HTMLTextAreaElement,
	): void {
		const value = textarea.value.trim();
		if (value.length === 0) return;
		const previousValue = textarea.value;
		textarea.value = "";
		this.replyDrafts.delete(item.id);
		this.replyDraftItemId = null;
		if (!this.plugin.insertReplyToMark(mark, value)) {
			textarea.value = previousValue;
			this.replyDrafts.set(item.id, previousValue);
			this.replyDraftItemId = item.id;
			return;
		}
		this.render();
	}

	private resolveThread(
		item: Extract<ReviewItem, { kind: "anchored-comment" }>,
	): void {
		if (item.anchor.type === "comment") {
			this.plugin.replaceReviewRangeFromSidebar(item.from, item.to, "");
		} else if (isSuggestion(item.anchor)) {
			this.plugin.replaceReviewRangeFromSidebar(item.anchor.to, item.to, "");
		} else {
			this.plugin.replaceReviewRangeFromSidebar(
				item.from,
				item.to,
				item.anchor.content,
			);
		}
		this.render();
	}

	private resolveReviewItem(item: ReviewItem): void {
		if (item.kind === "anchored-comment") {
			this.resolveThread(item);
		} else {
			this.applyMark(item.mark, "accept");
		}
	}

	private applyThreadSuggestionAction(
		item: Extract<ReviewItem, { kind: "anchored-comment" }>,
		action: CriticAction,
	): void {
		this.plugin.replaceReviewRangeFromSidebar(
			item.from,
			item.to,
			replacementForMark(item.anchor, action),
		);
		this.render();
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
		if (mark.type === "comment") {
			consumed.add(mark.id);
			continue;
		}

		const comments = collectThreadComments(marks, index, consumed);
		if (comments.length > 0) {
			const comment = comments[0];
			const lastComment = comments[comments.length - 1];
			consumed.add(mark.id);
			for (const threadComment of comments) {
				consumed.add(threadComment.id);
			}
			items.push({
				kind: "anchored-comment",
				id: `thread:${mark.id}`,
				type: mark.type,
				anchor: mark,
				comment,
				comments,
				from: mark.from,
				to: lastComment.to,
				line: mark.line,
			});
			continue;
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

function collectThreadComments(
	marks: CriticMark[],
	anchorIndex: number,
	consumed: Set<string>,
): CriticMark[] {
	const anchor = marks[anchorIndex];
	if (anchor.type === "comment") return [];
	const comments: CriticMark[] = [];
	let nextFrom = anchor.to;
	for (
		let candidateIndex = anchorIndex + 1;
		candidateIndex < marks.length;
		candidateIndex += 1
	) {
		const candidate = marks[candidateIndex];
		if (
			consumed.has(candidate.id) ||
			candidate.type !== "comment" ||
			candidate.from !== nextFrom
		) {
			break;
		}
		comments.push(candidate);
		nextFrom = candidate.to;
	}

	return comments;
}

function isSelected(item: ReviewItem, activeMarkId: string | null): boolean {
	if (!activeMarkId) return false;
	if (item.kind === "anchored-comment") {
		return (
			item.anchor.id === activeMarkId ||
			item.comments.some((comment) => comment.id === activeMarkId)
		);
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

function itemHasSecondaryActions(item: ReviewItem): boolean {
	return (
		(item.kind === "anchored-comment" && isSuggestion(item.anchor)) ||
		(item.kind === "mark" && (isSuggestion(item.mark) || item.mark.type === "comment"))
	);
}

function itemContainsComment(item: ReviewItem, commentId: string): boolean {
	if (item.kind === "anchored-comment") {
		return item.comments.some((comment) => comment.id === commentId);
	}
	return item.mark.type === "comment" && item.mark.id === commentId;
}

function formatCounts(items: ReviewItem[]): string {
	const comments = items.reduce((count, item) => {
		if (item.kind === "anchored-comment") return count + item.comments.length;
		return count + (item.type === "comment" ? 1 : 0);
	}, 0);
	const suggestions = items.filter(
		(item) =>
			(item.kind === "mark" && isSuggestion(item.mark)) ||
			(item.kind === "anchored-comment" && isSuggestion(item.anchor)),
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

function getItemLabel(item: ReviewItem): string {
	if (item.kind === "anchored-comment") return getMarkTitle(item.anchor);
	return getMarkTitle(item.mark);
}

function formatThreadSummary(
	item: Extract<ReviewItem, { kind: "anchored-comment" }>,
): string {
	const text = normalizeSummary(getMarkSummary(item.anchor));
	const summary = text.length > 0 ? text : getMarkTitle(item.anchor);
	return endWithEllipsis(summary);
}

function normalizeSummary(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function endWithEllipsis(text: string): string {
	const trimmed = text.trim();
	const clipped = trimmed.length > 96 ? trimmed.slice(0, 96).trimEnd() : trimmed;
	return clipped.endsWith("...") ? clipped : `${clipped}...`;
}

function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "?";
	return words
		.slice(0, 2)
		.map((word) => word[0]?.toUpperCase() ?? "")
		.join("");
}

function formatMarkDate(mark: CriticMark): string | null {
	const raw = mark.metadata?.date?.trim();
	if (!raw) return null;
	const date = new Date(raw);
	if (Number.isNaN(date.getTime())) return raw;
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(date);
}

export function getActiveMarkdownView(plugin: CriticMarkupPlugin): MarkdownView | null {
	return plugin.app.workspace.getActiveViewOfType(MarkdownView);
}
