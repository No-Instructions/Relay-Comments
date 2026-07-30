import {
	ItemView,
	Menu,
	Modal,
	Platform,
	Scope,
	setIcon,
	setTooltip,
	type App,
	type HoverPopover,
	type IconName,
	type WorkspaceLeaf,
} from "obsidian";
import { renderCommentBody } from "./comment-body";
import { collectAttachedComments } from "../critic/threading";
import {
	formatMarkDate,
	isSuggestionMark,
	normalizeWhitespace,
	normalizeQuoteText,
} from "../critic/display";
import {
	formatComposerSubmitHint,
	getComposerSubmitScopeBinding,
	isComposerSubmitKey,
} from "./composer-keys";
import { replacementForMark, type CriticAction } from "../critic/transform";
import type { CriticMark, CriticMarkType } from "../critic/types";
import type RelayCommentsPlugin from "../main";
import type { CommentDraft, ReviewerIdentity } from "../main";
import {
	groupExternalCommentComponents,
	type ExternalCommentComponent,
	type ExternalCommentGroup,
	type ExternalCommentState,
} from "../dom/comment-components";

export const VIEW_TYPE_CRITIC_REVIEW = "relay-comments-review-sidebar";

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
	onEdit?: () => void;
}

const MARK_TYPE_LABELS: Partial<Record<CriticMarkType, string>> = {
	addition: "Suggested addition",
	deletion: "Suggested deletion",
	substitution: "Suggested replacement",
	highlight: "Highlight",
};

interface PendingFocus {
	kind: "edit" | "draft";
	key: string;
}

export class ReviewSidebarView extends ItemView {
	/** HoverParent for page previews spawned from links in comments. */
	hoverPopover: HoverPopover | null = null;
	private selectedItemId: string | null = null;
	private replyDraftItemId: string | null = null;
	private editingCommentId: string | null = null;
	private replyDrafts = new Map<string, string>();
	private editDrafts = new Map<string, string>();
	private draftText = "";
	private pendingFocus: PendingFocus | null = null;
	private lastDraftKey: string | null = null;
	private lastScrolledItemId: string | null = null;
	private removeOutsideClickListener: (() => void) | null = null;
	private composerSubmits = new WeakMap<HTMLTextAreaElement, () => void>();
	private composerHintId = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: RelayCommentsPlugin,
	) {
		super(leaf);
		// The scope gives the configured submit key first chance before
		// Obsidian's global keymaps can consume it.
		const submitKey = getComposerSubmitScopeBinding();
		this.scope = new Scope(this.app.scope);
		this.scope.register(submitKey.modifiers, submitKey.key, (event) => {
			if (isComposerSubmitKey(event) && this.submitFocusedComposer()) {
				event.preventDefault();
				return false;
			}
			return true;
		});
	}

	private submitFocusedComposer(): boolean {
		const active = document.activeElement;
		if (
			!(active instanceof HTMLTextAreaElement) ||
			!this.contentEl.contains(active)
		) {
			return false;
		}
		const submit = this.composerSubmits.get(active);
		if (!submit) return false;
		submit();
		return true;
	}

	getViewType(): string {
		return VIEW_TYPE_CRITIC_REVIEW;
	}

	getDisplayText(): string {
		return "Relay Comments";
	}

	getIcon(): IconName {
		return "message-square-text";
	}

	protected async onOpen(): Promise<void> {
		this.installOutsideClickListener();
		// Focusing a composer must make this leaf active: otherwise Obsidian
		// treats the Markdown editor as the hotkey target and its global
		// Mod+Enter binding consumes the keydown before the textarea sees it.
		this.registerDomEvent(this.contentEl, "focusin", (event) => {
			if (!(event.target instanceof HTMLTextAreaElement)) return;
			if (this.app.workspace.activeLeaf === this.leaf) return;
			this.app.workspace.setActiveLeaf(this.leaf, { focus: false });
		});
		this.render();
	}

	protected async onClose(): Promise<void> {
		this.removeOutsideClickListener?.();
		this.removeOutsideClickListener = null;
	}

	refresh(): void {
		this.render();
	}

	activateThreadForRange(
		from: number,
		to: number,
		options?: { focusReply?: boolean },
	): void {
		const state = this.plugin.getActiveReviewState();
		if (!state) return;

		const validMarks = state.marks
			.filter((mark) => mark.valid)
			.sort((a, b) => a.from - b.from || a.to - b.to);
		const item = buildReviewItems(validMarks, state.editor.getValue()).find(
			(candidate) => {
				const target =
					candidate.kind === "anchored-comment"
						? candidate.anchor
						: candidate.mark;
				return target.from === from && target.to === to;
			},
		);
		if (!item) return;

		this.selectedItemId = item.id;
		this.replyDraftItemId = item.id;
		this.render();
		if (options?.focusReply) {
			this.containerEl
				.querySelector<HTMLTextAreaElement>(
					`[data-critic-item-id="${CSS.escape(item.id)}"] .critic-thread-textarea`,
				)
				?.focus();
		}
	}

	private render(): void {
		const focusSnapshot = this.captureComposerFocus();
		this.renderContent();
		this.restoreComposerFocus(focusSnapshot);
	}

	/**
	 * Keep the caret in a composer across re-renders (e.g. a collaborator's
	 * edit refreshing the sidebar while the user is typing).
	 */
	private captureComposerFocus(): {
		selector: string;
		start: number;
		end: number;
	} | null {
		const active = document.activeElement;
		if (
			!(active instanceof HTMLTextAreaElement) ||
			!this.contentEl.contains(active)
		) {
			return null;
		}
		let selector: string | null = null;
		if (active.classList.contains("critic-draft-textarea")) {
			selector = ".critic-draft-textarea";
		} else if (active.classList.contains("critic-edit-textarea")) {
			selector = ".critic-edit-textarea";
		} else if (active.classList.contains("critic-thread-textarea")) {
			const card = active.closest("[data-critic-item-id]");
			const itemId = card?.getAttribute("data-critic-item-id");
			if (itemId) {
				selector = `[data-critic-item-id="${CSS.escape(itemId)}"] .critic-thread-textarea`;
			}
		}
		if (!selector) return null;
		return {
			selector,
			start: active.selectionStart,
			end: active.selectionEnd,
		};
	}

	private restoreComposerFocus(
		snapshot: { selector: string; start: number; end: number } | null,
	): void {
		if (!snapshot) return;
		const textarea = this.contentEl.querySelector<HTMLTextAreaElement>(
			snapshot.selector,
		);
		if (!textarea) return;
		textarea.focus();
		const length = textarea.value.length;
		textarea.setSelectionRange(
			Math.min(snapshot.start, length),
			Math.min(snapshot.end, length),
		);
	}

	private renderContent(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("critic-sidebar");

		const externalState = this.plugin.getActiveExternalCommentState();
		if (externalState) {
			this.renderHeader(root, externalState.title);
			this.renderExternalComments(root, externalState);
			return;
		}

		const state = this.plugin.getActiveReviewState();
		this.renderHeader(root, state?.file.basename ?? "Relay Comments");
		if (!state) {
			this.renderEmptyState(root, "Open a Markdown note to review comments and suggestions.");
			return;
		}

		const validMarks = state.marks
			.filter((mark) => mark.valid)
			.sort((a, b) => a.from - b.from || a.to - b.to);
		const items = buildReviewItems(validMarks, state.editor.getValue());
		if (items.length > 0) {
			root.createDiv({
				cls: "critic-sidebar-counts",
				text: formatCounts(items),
			});
		}

		this.syncDraftFocus(state.commentDraft);
		const draft = state.commentDraft;

		if (items.length === 0) {
			if (draft) {
				this.renderDraft(root, draft);
			} else {
				this.renderEmptyState(
					root,
					"No comments or suggestions in this note yet. Select text and choose “Add comment” to start a discussion.",
				);
			}
			return;
		}

		const list = root.createDiv({ cls: "critic-sidebar-list" });
		let visiblySelectedId: string | null = null;
		// The draft renders at the list position its comment will occupy
		// once saved (document order), so saving never reorders the card
		// out from under the author.
		let draftRendered = false;
		for (const item of items) {
			if (draft && !draftRendered && draft.from <= item.from) {
				this.renderDraft(list, draft);
				draftRendered = true;
			}
			const selected = this.renderItem(
				list,
				item,
				isSelected(item, state.activeMarkId),
				state.file.path,
			);
			if (selected && !visiblySelectedId) {
				visiblySelectedId = item.id;
			}
		}
		if (draft && !draftRendered) {
			this.renderDraft(list, draft);
		}
		this.scrollSelectedIntoView(list, visiblySelectedId);
	}

	private renderExternalComments(
		root: HTMLElement,
		state: ExternalCommentState,
	): void {
		const groups = groupExternalCommentComponents(state.comments);
		if (state.comments.length === 0) {
			this.renderEmptyState(root, "No rendered comments in this view.");
			return;
		}

		root.createDiv({
			cls: "critic-sidebar-counts",
			text: `${state.comments.length} ${
				state.comments.length === 1 ? "comment" : "comments"
			} from this view`,
		});
		const list = root.createDiv({ cls: "critic-sidebar-list" });
		for (const group of groups) {
			this.renderExternalCommentGroup(list, group, state.filePath);
		}
	}

	private renderExternalCommentGroup(
		parent: HTMLElement,
		group: ExternalCommentGroup,
		filePath: string | null,
	): void {
		const itemId = `external:${group.snapshotKey}`;
		const selected = this.selectedItemId === itemId;
		const card = parent.createDiv({
			cls: selected
				? "critic-card critic-card-selected critic-external-card"
				: "critic-card critic-external-card",
			attr: {
				tabindex: "0",
				role: "button",
				"data-critic-item-id": itemId,
				"data-critic-type": "comment",
				...(group.status
					? { "data-critic-status": group.status }
					: {}),
			},
		});
		card.addEventListener("mousedown", (event) => {
			if (event.button !== 0) return;
			if ((event.target as HTMLElement).closest("button, textarea, input, a")) {
				return;
			}
			if (selected) return;
			this.locateExternalComment(itemId, group.comments[0]);
		});
		card.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			if (
				(event.target as HTMLElement).closest("button, textarea, input, a")
			) {
				return;
			}
			event.preventDefault();
			this.locateExternalComment(itemId, group.comments[0]);
		});

		if (group.label || group.status === "resolved") {
			const eyebrow = card.createDiv({ cls: "critic-card-eyebrow" });
			if (group.label) {
				eyebrow.createSpan({
					cls: "critic-eyebrow-label",
					text: group.label,
				});
			}
			if (group.status === "resolved") {
				eyebrow.createSpan({
					cls: "critic-thread-preview-badge",
					text: "Resolved",
				});
			}
		}

		const messages = card.createDiv({ cls: "critic-thread-messages" });
		for (const comment of group.comments) {
			this.renderExternalCommentMessage(messages, comment, filePath);
		}
	}

	private renderExternalCommentMessage(
		parent: HTMLElement,
		comment: ExternalCommentComponent,
		filePath: string | null,
	): void {
		const message = parent.createDiv({ cls: "critic-thread-message" });
		const identity = this.plugin.getReviewerIdentityForExternalAuthor(
			comment.author,
			filePath,
		);
		if (identity.source !== "fallback") {
			this.renderCommentHeader(message, { identity });
		}
		message.createDiv({
			cls: "critic-message-text",
			text: comment.bodyText,
		});
	}

	private locateExternalComment(
		itemId: string,
		comment: ExternalCommentComponent,
	): void {
		this.selectedItemId = itemId;
		this.replyDraftItemId = null;
		this.editingCommentId = null;
		this.plugin.revealExternalComment(comment);
		this.render();
	}

	private renderHeader(root: HTMLElement, title: string): void {
		const header = root.createDiv({ cls: "critic-sidebar-header" });
		header.createEl("h3", { text: title });
		const closeButton = header.createEl("button", {
			cls: "critic-icon-button critic-sidebar-close-button",
			attr: { "aria-label": "Close review sidebar" },
		});
		setTooltip(closeButton, "Close review sidebar");
		setIcon(closeButton, "x");
		closeButton.addEventListener("click", (event) => {
			event.stopPropagation();
			this.plugin.closeReviewSidebar(this.leaf);
		});
	}

	private renderEmptyState(root: HTMLElement, text: string): void {
		const empty = root.createDiv({ cls: "critic-sidebar-empty" });
		const icon = empty.createDiv({ cls: "critic-sidebar-empty-icon" });
		setIcon(icon, "message-square-text");
		empty.createDiv({ cls: "critic-sidebar-empty-text", text });
	}

	private syncDraftFocus(draft: CommentDraft | null): void {
		const draftKey = draft
			? `${draft.filePath}:${draft.from}:${draft.to}`
			: null;
		if (draftKey !== this.lastDraftKey) {
			this.draftText = "";
			if (draftKey) {
				this.pendingFocus = { kind: "draft", key: draftKey };
			}
		}
		this.lastDraftKey = draftKey;
	}

	private scrollSelectedIntoView(
		list: HTMLElement,
		selectedId: string | null,
	): void {
		if (selectedId && selectedId !== this.lastScrolledItemId) {
			list
				.querySelector(`[data-critic-item-id="${CSS.escape(selectedId)}"]`)
				?.scrollIntoView({ block: "nearest" });
		}
		this.lastScrolledItemId = selectedId;
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
			if (target.closest(".cm-critic-thread-anchor")) {
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

	private renderDraft(parent: HTMLElement, draft: CommentDraft): void {
		const draftKey = `${draft.filePath}:${draft.from}:${draft.to}`;
		const card = parent.createDiv({
			cls: "critic-card critic-draft-card critic-composer-shell",
		});
		this.renderCommentHeader(card, {
			identity: this.plugin.getCurrentReviewerIdentity(),
		});

		// Gate on the normalized text: a marker-only selection normalizes
		// to nothing, and an empty quote block is just a stray rail.
		const draftQuote = normalizeQuoteText(draft.selectedText);
		if (draftQuote.length > 0) {
			card.createDiv({
				cls: "critic-card-quote",
				text: draftQuote,
			});
		}
		const textarea = card.createEl("textarea", {
			cls: "critic-composer-textarea critic-draft-textarea",
			attr: { placeholder: "Write a comment…" },
		});
		textarea.value = this.draftText;
		this.installTextareaEventGuards(textarea);
		textarea.addEventListener("input", () => {
			this.draftText = textarea.value;
		});
		this.renderComposerHint(card, textarea);
		const actions = card.createDiv({ cls: "critic-composer-actions" });
		const submit = this.addTextButton(
			actions,
			"Comment",
			() => this.commitDraftComment(textarea),
			{ primary: true },
		);
		this.addTextButton(actions, "Cancel", () => {
			void this.cancelDraftComment(textarea);
		});
		this.addComposerHelpButton(actions);
		bindSubmitToContent(textarea, submit, card);
		this.composerSubmits.set(textarea, () => {
			if (!submit.disabled) {
				this.commitDraftComment(textarea);
			}
		});
		textarea.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Escape") {
				event.preventDefault();
				void this.cancelDraftComment(textarea);
				return;
			}
			if (!isComposerSubmitKey(event)) return;
			event.preventDefault();
			if (!submit.disabled) {
				this.commitDraftComment(textarea);
			}
		});
		this.consumePendingFocus("draft", draftKey, textarea);
	}

	private async cancelDraftComment(textarea: HTMLTextAreaElement): Promise<void> {
		if (!(await this.confirmDiscardIfNeeded(textarea.value.trim().length > 0))) {
			textarea.focus();
			return;
		}
		this.plugin.cancelCommentDraft();
	}

	private commitDraftComment(textarea: HTMLTextAreaElement): void {
		const value = textarea.value.trim();
		if (value.length === 0) return;
		void this.plugin.commitCommentDraft(value);
	}

	private renderItem(
		parent: HTMLElement,
		item: ReviewItem,
		selected: boolean,
		filePath: string,
	): boolean {
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
				"data-critic-type": item.type,
			},
		});
		// Select on mousedown: selecting a card changes the layout (reply box
		// appears/disappears), and waiting for a full click would let the card
		// move out from under the cursor before mouseup.
		card.addEventListener("mousedown", (event) => {
			if (event.button !== 0) return;
			if ((event.target as HTMLElement).closest("button, textarea, input, a")) {
				return;
			}
			if (this.selectedItemId === item.id) return;
			this.locateItem(item);
		});
		card.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			if (
				(event.target as HTMLElement).closest("button, textarea, input, a")
			) {
				return;
			}
			event.preventDefault();
			this.locateItem(item);
		});

		if (item.kind === "anchored-comment") {
			this.renderAnchoredThread(card, item, isThreadSelected, filePath);
			return isThreadSelected;
		}

		const toolbar = card.createDiv({ cls: "critic-thread-toolbar" });
		this.addCardActions(toolbar, item);
		this.renderTypeEyebrow(card, item.mark.type);
		const identity = this.plugin.getReviewerIdentityForMark(item.mark, filePath);
		if (identity.source !== "fallback") {
			this.renderCommentHeader(card, { identity, mark: item.mark });
		}
		this.renderMarkBody(card, item.mark);
		this.renderReplyComposer(card, item, item.mark, isThreadSelected);
		return isThreadSelected;
	}

	private renderAnchoredThread(
		card: HTMLElement,
		item: Extract<ReviewItem, { kind: "anchored-comment" }>,
		selected: boolean,
		filePath: string,
	): void {
		const toolbar = card.createDiv({ cls: "critic-thread-toolbar" });
		this.addCardActions(toolbar, item);

		if (item.anchor.type === "highlight") {
			const quote = normalizeQuoteText(item.anchor.content);
			if (quote.length > 0) {
				card.createDiv({ cls: "critic-card-quote", text: quote });
			}
		} else if (isSuggestionMark(item.anchor)) {
			this.renderTypeEyebrow(card, item.anchor.type);
			const identity = this.plugin.getReviewerIdentityForMark(
				item.anchor,
				filePath,
			);
			if (identity.source !== "fallback") {
				this.renderCommentHeader(card, { identity, mark: item.anchor });
			}
			this.renderMarkBody(card, item.anchor);
		}

		this.renderThreadMessages(card, item.comments, filePath, item);
		if (!this.isEditingInItem(item)) {
			this.renderReplyComposer(
				card,
				item,
				item.comments[item.comments.length - 1] ?? item.anchor,
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
			renderCommentBody(
				message.createDiv({ cls: "critic-message-text" }),
				comment.content,
				{ app: this.app, sourcePath: filePath, hoverParent: this },
			);
		}
	}

	private renderCommentHeader(
		parent: HTMLElement,
		options: CommentHeaderOptions,
	): void {
		const header = parent.createDiv({ cls: "critic-comment-header" });
		const identity = header.createDiv({ cls: "critic-comment-identity" });
		this.renderAvatar(identity, options.identity);
		const byline = identity.createDiv({ cls: "critic-comment-byline" });
		byline.createDiv({ cls: "critic-comment-author", text: options.identity.name });
		const date = options.mark ? formatMarkDate(options.mark) : null;
		if (date) {
			byline.createDiv({ cls: "critic-comment-date", text: date });
		}
		if (options.onEdit) {
			this.addCommentActions(header, options.onEdit);
		}
	}

	private renderTypeEyebrow(parent: HTMLElement, type: CriticMarkType): void {
		const label = MARK_TYPE_LABELS[type];
		if (!label) return;
		const eyebrow = parent.createDiv({ cls: "critic-card-eyebrow" });
		eyebrow.createSpan({ cls: "critic-eyebrow-label", text: label });
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

		const unknown = identity.source === "fallback";
		const avatar = parent.createDiv({
			cls: unknown ? "critic-avatar critic-avatar-unknown" : "critic-avatar",
			text: unknown ? "?" : initials(identity.name),
		});
		if (!unknown && identity.color) {
			avatar.style.backgroundColor = identity.color;
		}
	}

	private renderMarkBody(card: HTMLElement, mark: CriticMark): void {
		if (mark.type === "highlight") {
			const quote = normalizeQuoteText(mark.content);
			if (quote.length > 0) {
				card.createDiv({ cls: "critic-card-quote", text: quote });
			}
			return;
		}

		const body = card.createDiv({ cls: "critic-card-body critic-card-diff" });
		const addChip = (cls: string, text: string): void => {
			const content = normalizeWhitespace(text);
			if (content.length === 0) return;
			body.createSpan({ cls: `critic-chip ${cls}`, text: content });
		};
		switch (mark.type) {
			case "addition":
				addChip("critic-chip-new", mark.content);
				break;
			case "deletion":
				addChip("critic-chip-old", mark.content);
				break;
			case "substitution": {
				addChip("critic-chip-old", mark.oldText ?? "");
				if (
					normalizeWhitespace(mark.oldText ?? "").length > 0 &&
					normalizeWhitespace(mark.newText ?? "").length > 0
				) {
					body.createSpan({ cls: "critic-diff-arrow", text: "→" });
				}
				addChip("critic-chip-new", mark.newText ?? "");
				break;
			}
			default:
				body.setText(mark.content);
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
		// setTooltip, never the title attribute: a title makes the browser's
		// native tooltip appear alongside Obsidian's styled one.
		const button = parent.createEl("button", {
			cls: "critic-icon-button critic-check-button",
			attr: { "aria-label": "Resolve" },
		});
		setTooltip(button, "Resolve");
		setIcon(button, "check");
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			this.resolveReviewItem(item);
		});
	}

	private addOverflowMenu(parent: HTMLElement, item: ReviewItem): void {
		const button = parent.createEl("button", {
			cls: "critic-icon-button",
			attr: { "aria-label": "More actions" },
		});
		setTooltip(button, "More actions");
		setIcon(button, "more-horizontal");
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			const menu = new Menu();
			const suggestion =
				item.kind === "anchored-comment"
					? isSuggestionMark(item.anchor)
						? item.anchor
						: null
					: isSuggestionMark(item.mark)
						? item.mark
						: null;
			if (suggestion) {
				menu.addItem((menuItem) => {
					menuItem
						.setTitle("Accept suggestion")
						.setIcon("check")
						.onClick(() => this.applySuggestionAction(item, "accept"));
				});
				menu.addItem((menuItem) => {
					menuItem
						.setTitle("Reject suggestion")
						.setIcon("x")
						.onClick(() => this.applySuggestionAction(item, "reject"));
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
			attr: { "aria-label": "More actions" },
		});
		setTooltip(button, "More actions");
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
		options: { primary?: boolean } = {},
	): HTMLButtonElement {
		const button = parent.createEl("button", {
			text: label,
			attr: { type: "button" },
		});
		button.addClass("critic-text-button");
		if (options.primary) {
			button.addClass("critic-button-primary");
		}
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			callback();
		});
		return button;
	}

	private renderComposerHint(
		parent: HTMLElement,
		textarea: HTMLTextAreaElement,
	): void {
		// Keyboard chords mean nothing on a phone; describe the visible
		// buttons for assistive tech instead.
		const hint = Platform.isMobile
			? "Use the buttons below the text field to submit or cancel"
			: formatComposerSubmitHint(Platform.isMacOS);
		const descriptionId = `relay-comments-composer-hint-${++this.composerHintId}`;
		textarea.setAttr("aria-describedby", descriptionId);
		const description = parent.createDiv({
			cls: "critic-composer-hint-sr",
			attr: { id: descriptionId },
		});
		description.setText(hint);
	}

	private addComposerHelpButton(
		parent: HTMLElement,
	): HTMLButtonElement | null {
		// The button's whole payload is a keyboard-shortcut tooltip;
		// there's nothing it can teach a phone.
		if (Platform.isMobile) return null;
		const hint = formatComposerSubmitHint(Platform.isMacOS);
		const tooltipId = `relay-comments-composer-help-${++this.composerHintId}`;
		const wrapper = parent.createSpan({ cls: "critic-composer-help" });
		const button = wrapper.createEl("button", {
			cls: "critic-icon-button critic-composer-help-button",
			attr: {
				type: "button",
				"aria-label": "Show composer shortcuts",
				"aria-describedby": tooltipId,
				"aria-expanded": "false",
			},
		});
		setIcon(button, "keyboard");
		wrapper.createDiv({
			cls: "critic-composer-help-tooltip",
			text: hint,
			attr: { id: tooltipId, role: "tooltip" },
		});

		const show = (): void => {
			wrapper.classList.remove("is-suppressed");
			button.setAttr("aria-expanded", "true");
		};
		const hide = (): void => button.setAttr("aria-expanded", "false");
		wrapper.addEventListener("mouseenter", show);
		wrapper.addEventListener("mouseleave", () => {
			if (document.activeElement !== button) hide();
		});
		button.addEventListener("focus", show);
		button.addEventListener("blur", hide);
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			button.focus();
			show();
		});
		button.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key !== "Escape") return;
			event.preventDefault();
			wrapper.classList.add("is-suppressed");
			hide();
		});
		return button;
	}

	private installTextareaEventGuards(textarea: HTMLTextAreaElement): void {
		textarea.addEventListener("click", (event) => event.stopPropagation());
		textarea.addEventListener("keydown", (event) => event.stopPropagation());
		textarea.addEventListener("keypress", (event) => event.stopPropagation());
		textarea.addEventListener("keyup", (event) => event.stopPropagation());
	}

	private consumePendingFocus(
		kind: PendingFocus["kind"],
		key: string,
		textarea: HTMLTextAreaElement,
	): void {
		if (this.pendingFocus?.kind !== kind || this.pendingFocus.key !== key) {
			return;
		}
		window.setTimeout(() => {
			// A re-render may have replaced this textarea before the timeout
			// fired; keep the pending focus armed so the next render retries.
			if (!textarea.isConnected) return;
			if (this.pendingFocus?.kind === kind && this.pendingFocus.key === key) {
				this.pendingFocus = null;
			}
			textarea.focus();
			const end = textarea.value.length;
			textarea.setSelectionRange(end, end);
		}, 0);
	}

	private locateItem(item: ReviewItem): void {
		if (this.editingCommentId && !itemContainsComment(item, this.editingCommentId)) {
			this.editingCommentId = null;
		}
		this.selectedItemId = item.id;
		this.replyDraftItemId = item.id;
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
		this.pendingFocus = { kind: "edit", key: comment.id };
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
		const editor = parent.createDiv({
			cls: "critic-edit-composer critic-composer-shell",
		});
		const textarea = editor.createEl("textarea", {
			cls: "critic-composer-textarea critic-edit-textarea",
			attr: { placeholder: "Edit comment…" },
		});
		textarea.value = this.editDrafts.get(comment.id) ?? comment.content;
		this.installTextareaEventGuards(textarea);
		textarea.addEventListener("input", () => {
			this.editDrafts.set(comment.id, textarea.value);
		});
		this.renderComposerHint(editor, textarea);
		const actions = editor.createDiv({ cls: "critic-composer-actions" });
		const submit = this.addTextButton(
			actions,
			"Save",
			() => this.commitCommentEdit(item, comment, textarea),
			{ primary: true },
		);
		this.addTextButton(actions, "Cancel", () => {
			void this.cancelEditingComment(comment.id, textarea, comment.content);
		});
		this.addComposerHelpButton(actions);
		bindSubmitToContent(
			textarea,
			submit,
			editor,
			(value) => value.trim().length > 0 && value !== comment.content,
		);
		this.composerSubmits.set(textarea, () => {
			if (!submit.disabled) {
				this.commitCommentEdit(item, comment, textarea);
			}
		});
		textarea.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Escape") {
				event.preventDefault();
				void this.cancelEditingComment(comment.id, textarea, comment.content);
				return;
			}
			if (!isComposerSubmitKey(event)) return;
			event.preventDefault();
			if (!submit.disabled) {
				this.commitCommentEdit(item, comment, textarea);
			}
		});
		this.consumePendingFocus("edit", comment.id, textarea);
	}

	private async cancelEditingComment(
		commentId: string,
		textarea: HTMLTextAreaElement,
		originalValue: string,
	): Promise<void> {
		if (!(await this.confirmDiscardIfNeeded(textarea.value !== originalValue))) {
			textarea.focus();
			return;
		}
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

		const composer = card.createDiv({
			cls: "critic-thread-composer critic-composer-shell",
		});
		const textarea = composer.createEl("textarea", {
			cls: "critic-thread-textarea",
			attr: { placeholder: "Reply…" },
		});
		textarea.value = this.replyDrafts.get(item.id) ?? "";
		this.installTextareaEventGuards(textarea);
		textarea.addEventListener("input", () => {
			this.replyDrafts.set(item.id, textarea.value);
		});
		this.renderComposerHint(composer, textarea);
		const actions = composer.createDiv({ cls: "critic-composer-actions" });
		const submit = this.addTextButton(
			actions,
			"Reply",
			() => this.commitThreadReply(item, mark, textarea),
			{ primary: true },
		);
		this.addTextButton(actions, "Cancel", () => {
			void this.cancelThreadReply(item, textarea);
		});
		this.addComposerHelpButton(actions);
		bindSubmitToContent(textarea, submit, composer);
		this.composerSubmits.set(textarea, () => {
			if (!submit.disabled) {
				this.commitThreadReply(item, mark, textarea);
			}
		});
		textarea.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Escape") {
				event.preventDefault();
				void this.cancelThreadReply(item, textarea);
				return;
			}
			if (!isComposerSubmitKey(event)) return;
			event.preventDefault();
			if (!submit.disabled) {
				this.commitThreadReply(item, mark, textarea);
			}
		});
	}

	private async cancelThreadReply(
		item: ReviewItem,
		textarea: HTMLTextAreaElement,
	): Promise<void> {
		if (!(await this.confirmDiscardIfNeeded(textarea.value.trim().length > 0))) {
			textarea.focus();
			return;
		}
		this.replyDrafts.delete(item.id);
		this.replyDraftItemId = null;
		this.render();
	}

	private async confirmDiscardIfNeeded(hasChanges: boolean): Promise<boolean> {
		if (!hasChanges) return true;
		return confirmDiscardDraft(this.app);
	}

	private async commitThreadReply(
		item: ReviewItem,
		mark: CriticMark,
		textarea: HTMLTextAreaElement,
	): Promise<void> {
		const value = textarea.value.trim();
		if (value.length === 0) return;
		const previousValue = textarea.value;
		textarea.value = "";
		this.replyDrafts.delete(item.id);
		this.replyDraftItemId = null;
		if (!(await this.plugin.insertReplyToMark(mark, value))) {
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
		} else if (isSuggestionMark(item.anchor)) {
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

	private applySuggestionAction(item: ReviewItem, action: CriticAction): void {
		if (item.kind === "anchored-comment") {
			this.plugin.replaceReviewRangeFromSidebar(
				item.from,
				item.to,
				replacementForMark(item.anchor, action),
			);
			this.render();
		} else {
			this.applyMark(item.mark, action);
		}
	}

	private applyMark(mark: CriticMark, action: CriticAction): void {
		this.plugin.applyMarkActionFromSidebar(mark, action);
		this.render();
	}
}

function confirmDiscardDraft(app: App): Promise<boolean> {
	return new Promise((resolve) => {
		new DiscardDraftModal(app, resolve).open();
	});
}

class DiscardDraftModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private resolve: (discard: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("critic-discard-modal");
		contentEl.createEl("h2", { text: "Discard draft?" });
		contentEl.createDiv({
			cls: "critic-discard-message",
			text: "Keep writing or discard this unsaved text.",
		});

		const actions = contentEl.createDiv({ cls: "critic-discard-actions" });
		const keepWriting = actions.createEl("button", {
			cls: "mod-cta",
			text: "Keep writing",
			attr: { type: "button" },
		});
		keepWriting.addEventListener("click", () => this.keepWriting());
		const discard = actions.createEl("button", {
			text: "Discard",
			attr: { type: "button" },
		});
		discard.addEventListener("click", () => this.discard());
		window.setTimeout(() => keepWriting.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.resolve(false);
		}
	}

	private keepWriting(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(false);
		this.close();
	}

	private discard(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(true);
		this.close();
	}
}

function getItemTargetRange(item: ReviewItem): { from: number; to: number } {
	if (item.kind === "anchored-comment") {
		return { from: item.anchor.from, to: item.anchor.to };
	}
	return { from: item.mark.from, to: item.mark.to };
}

function buildReviewItems(marks: CriticMark[], text: string): ReviewItem[] {
	const items: ReviewItem[] = [];
	const consumed = new Set<string>();

	for (let index = 0; index < marks.length; index += 1) {
		const mark = marks[index];
		if (consumed.has(mark.id)) continue;

		const attached = collectAttachedComments(marks, text, index, consumed, {
			allowCommentAnchor: true,
		}).comments;
		consumed.add(mark.id);
		for (const comment of attached) {
			consumed.add(comment.id);
		}

		// Empty comments never render anywhere; the run's full extent is still
		// used for ranges so resolving a thread removes the markup completely.
		const run = mark.type === "comment" ? [mark, ...attached] : attached;
		const visible = run.filter(
			(comment) => comment.content.trim().length > 0,
		);
		const last = run[run.length - 1] ?? mark;

		if (visible.length > 0) {
			items.push({
				kind: "anchored-comment",
				id: `thread:${mark.id}`,
				type: mark.type,
				anchor: mark,
				comment: visible[0],
				comments: visible,
				from: mark.from,
				to: Math.max(mark.to, last.to),
				line: mark.line,
			});
			continue;
		}
		if (mark.type === "comment") {
			// A run of only-empty comments: invisible markup, nothing to show.
			continue;
		}

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
		return (
			item.anchor.id === activeMarkId ||
			item.comments.some((comment) => comment.id === activeMarkId)
		);
	}
	return item.mark.id === activeMarkId;
}

function itemHasSecondaryActions(item: ReviewItem): boolean {
	return (
		(item.kind === "anchored-comment" && isSuggestionMark(item.anchor)) ||
		(item.kind === "mark" && isSuggestionMark(item.mark))
	);
}

function itemContainsComment(item: ReviewItem, commentId: string): boolean {
	if (item.kind === "anchored-comment") {
		return item.comments.some((comment) => comment.id === commentId);
	}
	return item.mark.type === "comment" && item.mark.id === commentId;
}

function bindSubmitToContent(
	textarea: HTMLTextAreaElement,
	submit: HTMLButtonElement,
	composer?: HTMLElement,
	canSubmit: (value: string) => boolean = (value) => value.trim().length > 0,
): void {
	const update = () => {
		submit.disabled = !canSubmit(textarea.value);
		composer?.toggleClass("has-content", textarea.value.length > 0);
	};
	textarea.addEventListener("input", update);
	update();
}

function formatCounts(items: ReviewItem[]): string {
	const comments = items.reduce((count, item) => {
		if (item.kind === "anchored-comment") return count + item.comments.length;
		return count;
	}, 0);
	const suggestions = items.filter(
		(item) =>
			(item.kind === "mark" && isSuggestionMark(item.mark)) ||
			(item.kind === "anchored-comment" && isSuggestionMark(item.anchor)),
	).length;
	const highlights = items.filter(
		(item) => item.kind === "mark" && item.type === "highlight",
	).length;
	const parts: string[] = [];
	if (comments > 0) parts.push(`${comments} ${comments === 1 ? "comment" : "comments"}`);
	if (suggestions > 0) {
		parts.push(`${suggestions} ${suggestions === 1 ? "suggestion" : "suggestions"}`);
	}
	if (highlights > 0) {
		parts.push(`${highlights} ${highlights === 1 ? "highlight" : "highlights"}`);
	}
	return parts.join(" · ");
}

function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "?";
	return words
		.slice(0, 2)
		.map((word) => word[0]?.toUpperCase() ?? "")
		.join("");
}
