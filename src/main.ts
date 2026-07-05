import {
	MarkdownView,
	Notice,
	Plugin,
	type Editor,
	type Hotkey,
	type MarkdownFileInfo,
	type Menu,
	type TFile,
	type WorkspaceLeaf,
} from "obsidian";
import type { Extension } from "@codemirror/state";
import { EditorView as CodeMirrorEditorView } from "@codemirror/view";
import { parseCriticMarkup } from "./critic/parse";
import {
	CRITIC_SECTION_SEPARATOR,
	collectAttachedComments,
} from "./critic/threading";
import type { CriticAction } from "./critic/transform";
import type { CriticMark, DisplayMode } from "./critic/types";
import {
	clampPreviewSnippet,
	findPrecedingWordRange,
	formatMarkDate,
	getPreviewAnchorText,
	isSuggestionMark,
	normalizeWhitespace,
	rectDrifted,
} from "./critic/display";
import {
	applyAllInEditor,
	applyCurrentMarkAction,
	replaceMark,
	wrapSelection,
	addSubstitution,
	getCurrentMark,
} from "./editor/commands";
import {
	createReviewEditorExtension,
	type ReviewEditorController,
} from "./editor/extension";
import { ADD_COMMENT_HOTKEYS } from "./editor/hotkeys";
import { createReviewPostProcessor } from "./preview/postprocessor";
import {
	resolveSettings,
	RelayCommentsSettingTab,
	type RelayCommentsSettings,
} from "./settings";
import {
	ReviewSidebarView,
	VIEW_TYPE_CRITIC_REVIEW,
} from "./ui/ReviewSidebarView";

export interface ActiveReviewState {
	file: TFile;
	editor: Editor;
	marks: CriticMark[];
	activeMarkId: string | null;
	commentDraft: CommentDraft | null;
}

export interface CommentDraft {
	filePath: string;
	from: number;
	to: number;
	selectedText: string;
}

export interface ReviewerIdentity {
	id?: string;
	name: string;
	picture?: string;
	color?: string;
	colorLight?: string;
	source: "metadata" | "relay" | "fallback";
}

interface ClientRectLike {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

interface CodeMirrorAdapter {
	coordsAtPos(pos: number): ClientRectLike | null;
	dispatch(spec?: { effects?: unknown }): void;
	dom?: HTMLElement;
	scrollDOM?: HTMLElement;
}

interface ThreadPreviewData {
	label: string;
	countLabel: string;
	anchorText: string;
	snippet: string;
	moreLabel: string | null;
	author: string | null;
	date: string | null;
	resolved: boolean;
}

interface ActiveThreadPreview {
	element: HTMLElement;
	anchor: HTMLElement | null;
	originalTitle: string | null;
	originalAriaDescribedBy: string | null;
	returnFocus: (() => void) | null;
	cleanup: () => void;
}

interface RelayUserLike {
	id?: string;
	name?: string;
	email?: string;
	picture?: string;
	color?: string | { color?: string; light?: string };
	colorLight?: string;
}

interface RelayUserCollectionLike {
	get(id: string): RelayUserLike | undefined;
}

interface RelayUserIdListLike {
	toArray(): unknown[];
}

interface RelayUserEntryLike {
	get(key: string): RelayUserIdListLike | undefined;
}

interface RelayYItemLike {
	length: number;
	deleted?: boolean;
	id?: { client?: unknown };
	right?: RelayYItemLike | null;
}

interface RelayYTextLike {
	_start?: RelayYItemLike | null;
}

interface RelayYUserMapLike {
	forEach(callback: (entry: RelayUserEntryLike, userId: string) => void): void;
}

interface RelayYDocLike {
	getMap(name: string): RelayYUserMapLike;
	getText(name: string): RelayYTextLike;
}

interface RelayDocumentLike {
	localDoc?: RelayYDocLike;
}

interface RelaySharedFolderLike {
	proxy?: {
		getDoc(path: string): RelayDocumentLike | undefined;
	};
	getUserDisplayName?(userId: string): string | undefined;
}

interface RelaySharedFoldersLike {
	lookup(path: string): RelaySharedFolderLike | undefined;
	manager?: {
		user?: RelayUserLike;
		users?: RelayUserCollectionLike;
	};
}

interface RelayPluginLike {
	loginManager?: {
		user?: RelayUserLike;
	};
	relayManager?: {
		user?: RelayUserLike;
		users?: RelayUserCollectionLike;
	};
	sharedFolders?: RelaySharedFoldersLike;
}

export default class RelayCommentsPlugin
	extends Plugin
	implements ReviewEditorController
{
	settings!: RelayCommentsSettings;
	private renderVersion = 0;
	private commentDraft: CommentDraft | null = null;
	private lastMarkdownPath: string | null = null;
	private reviewSidebarOpenPromise: Promise<void> | null = null;
	private selectionRefreshTimer: number | null = null;
	private previewShowTimer: number | null = null;
	private previewHideTimer: number | null = null;
	private activeThreadPreview: ActiveThreadPreview | null = null;
	private previewId = 0;
	private readonly editorExtensions: Extension[] = [];

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_CRITIC_REVIEW,
			(leaf: WorkspaceLeaf) => new ReviewSidebarView(leaf, this),
		);
		this.editorExtensions.length = 0;
		this.editorExtensions.push(createReviewEditorExtension(this));
		this.registerEditorExtension(this.editorExtensions);
		this.app.workspace.updateOptions();
		this.registerMarkdownPostProcessor(createReviewPostProcessor(this));
		this.addSettingTab(new RelayCommentsSettingTab(this.app, this));

		this.addRibbonIcon("message-square-text", "Open Relay Comments", () => {
			void this.toggleReviewSidebarFromRibbon();
		});

		this.registerCommands();
		this.registerWorkspaceEvents();
		this.queueEditorExtensionRefresh(0);
		this.queueEditorExtensionRefresh(250);

		this.app.workspace.onLayoutReady(() => {
			this.queueEditorExtensionRefresh(0);
			this.queueEditorExtensionRefresh(250);
			this.refreshReviewSidebars();
		});
	}

	onunload(): void {
		this.reviewSidebarOpenPromise = null;
		if (this.selectionRefreshTimer !== null) {
			window.clearTimeout(this.selectionRefreshTimer);
			this.selectionRefreshTimer = null;
		}
		this.hideThreadPreview();
		this.editorExtensions.length = 0;
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_CRITIC_REVIEW);
		this.app.workspace.updateOptions();
		this.refreshOpenEditors();
	}

	notifyEditorSelectionChanged(): void {
		if (this.selectionRefreshTimer !== null) {
			window.clearTimeout(this.selectionRefreshTimer);
		}
		this.selectionRefreshTimer = window.setTimeout(() => {
			this.selectionRefreshTimer = null;
			this.refreshReviewSidebars();
		}, 120);
	}

	getDisplayMode(path?: string | null): DisplayMode {
		return "review";
	}

	getRenderVersion(): number {
		return this.renderVersion;
	}

	shouldShowInlineActions(): boolean {
		return this.settings.showInlineActions;
	}

	activateCommentThread(path: string | null, from: number, to: number): void {
		const filePath = path ?? this.app.workspace.getActiveFile()?.path ?? null;
		if (filePath) {
			this.lastMarkdownPath = filePath;
		}

		const activate = (leaf: WorkspaceLeaf | undefined) => {
			if (leaf?.view instanceof ReviewSidebarView) {
				leaf.view.activateThreadForRange(from, to);
			}
		};

		const existing = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_CRITIC_REVIEW,
		)[0];
		if (existing) {
			void this.app.workspace.revealLeaf(existing).then(() => activate(existing));
			return;
		}

		if (!this.settings.openSidebarOnCommentSelect) {
			return;
		}

		void this.openReviewSidebar().then(() => {
			activate(this.app.workspace.getLeavesOfType(VIEW_TYPE_CRITIC_REVIEW)[0]);
		});
	}

	queueThreadPreview(
		path: string | null,
		from: number,
		to: number,
		anchor: HTMLElement,
	): void {
		const active = document.activeElement;
		if (
			active instanceof HTMLTextAreaElement &&
			active.closest(".critic-sidebar")
		) {
			return;
		}
		const filePath = path ?? this.app.workspace.getActiveFile()?.path ?? null;
		if (!filePath || !anchor.isConnected) return;
		const previewId = this.previewId + 1;
		this.previewId = previewId;
		this.clearPreviewTimers();
		this.previewShowTimer = window.setTimeout(() => {
			if (this.previewId !== previewId || !anchor.isConnected) return;
			this.showThreadPreview(filePath, from, to, anchor.getBoundingClientRect(), {
				anchor,
				returnFocus: null,
				role: "tooltip",
			});
		}, 300);
	}

	scheduleThreadPreviewDismiss(): void {
		if (this.previewShowTimer !== null) {
			window.clearTimeout(this.previewShowTimer);
			this.previewShowTimer = null;
		}
		if (!this.activeThreadPreview) return;
		if (this.previewHideTimer !== null) {
			window.clearTimeout(this.previewHideTimer);
		}
		this.previewHideTimer = window.setTimeout(() => {
			this.hideThreadPreview();
		}, 180);
	}

	hideThreadPreview(): void {
		this.clearPreviewTimers();
		const active = this.activeThreadPreview;
		if (!active) return;
		this.activeThreadPreview = null;
		active.cleanup();
		active.element.remove();
		active.returnFocus?.();
	}

	private clearPreviewTimers(): void {
		if (this.previewShowTimer !== null) {
			window.clearTimeout(this.previewShowTimer);
			this.previewShowTimer = null;
		}
		if (this.previewHideTimer !== null) {
			window.clearTimeout(this.previewHideTimer);
			this.previewHideTimer = null;
		}
	}

	private showThreadPreview(
		filePath: string,
		from: number,
		to: number,
		anchorRect: ClientRectLike,
		options: {
			anchor: HTMLElement | null;
			returnFocus: (() => void) | null;
			role: "tooltip" | "dialog";
		},
	): boolean {
		const data = this.buildThreadPreviewData(filePath, from, to);
		if (!data) return false;
		this.hideThreadPreview();

		const element = this.renderThreadPreview(data, options.role);
		document.body.appendChild(element);
		this.positionThreadPreview(element, anchorRect);
		const previousTitle = options.anchor?.getAttribute("title") ?? null;
		const previousDescribedBy =
			options.anchor?.getAttribute("aria-describedby") ?? null;
		if (options.anchor) {
			options.anchor.removeAttribute("title");
			options.anchor.setAttribute("aria-describedby", element.id);
		}

		const cancelDismiss = () => {
			if (this.previewHideTimer !== null) {
				window.clearTimeout(this.previewHideTimer);
				this.previewHideTimer = null;
			}
		};
		const scheduleDismiss = () => this.scheduleThreadPreviewDismiss();
		const onDocumentMouseDown = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (
				target &&
				(element.contains(target) ||
					(options.anchor?.contains(target) ?? false))
			) {
				return;
			}
			this.hideThreadPreview();
		};
		const onDocumentKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			this.hideThreadPreview();
		};
		const onScroll = () => this.hideThreadPreview();
		// The preview is positioned once at fixed viewport coordinates. Any
		// anchor movement that is not a scroll (window or splitter resize,
		// panes reflowing, zoom changes) would orphan it — watch the anchor
		// and dismiss the moment it drifts.
		const onResize = () => this.hideThreadPreview();
		const anchorHomeRect = options.anchor?.getBoundingClientRect() ?? null;
		const driftWatcher = window.setInterval(() => {
			const watched = options.anchor;
			if (!watched || !anchorHomeRect) return;
			if (
				!watched.isConnected ||
				rectDrifted(anchorHomeRect, watched.getBoundingClientRect())
			) {
				this.hideThreadPreview();
			}
		}, 120);
		element.addEventListener("pointerenter", cancelDismiss);
		element.addEventListener("pointerleave", scheduleDismiss);
		document.addEventListener("mousedown", onDocumentMouseDown, true);
		document.addEventListener("keydown", onDocumentKeyDown, true);
		document.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onResize);

		this.activeThreadPreview = {
			element,
			anchor: options.anchor,
			originalTitle: previousTitle,
			originalAriaDescribedBy: previousDescribedBy,
			returnFocus: options.returnFocus,
			cleanup: () => {
				element.removeEventListener("pointerenter", cancelDismiss);
				element.removeEventListener("pointerleave", scheduleDismiss);
				document.removeEventListener("mousedown", onDocumentMouseDown, true);
				document.removeEventListener("keydown", onDocumentKeyDown, true);
				document.removeEventListener("scroll", onScroll, true);
				window.removeEventListener("resize", onResize);
				window.clearInterval(driftWatcher);
				if (options.anchor) {
					if (previousTitle === null) {
						options.anchor.removeAttribute("title");
					} else {
						options.anchor.setAttribute("title", previousTitle);
					}
					if (previousDescribedBy === null) {
						options.anchor.removeAttribute("aria-describedby");
					} else {
						options.anchor.setAttribute(
							"aria-describedby",
							previousDescribedBy,
						);
					}
				}
			},
		};
		if (options.role === "dialog") {
			element.focus();
		}
		return true;
	}

	private renderThreadPreview(
		data: ThreadPreviewData,
		role: "tooltip" | "dialog",
	): HTMLElement {
		const element = document.createElement("div");
		element.id = `critic-thread-preview-${this.previewId}`;
		element.className = data.resolved
			? "critic-thread-preview is-resolved"
			: "critic-thread-preview";
		element.setAttribute("role", role);
		element.setAttribute(
			role === "dialog" ? "aria-label" : "aria-live",
			role === "dialog" ? "Comment preview" : "polite",
		);
		if (role === "dialog") {
			element.tabIndex = -1;
		}

		const header = element.createDiv({ cls: "critic-thread-preview-header" });
		header.createSpan({ cls: "critic-thread-preview-label", text: data.label });
		header.createSpan({
			cls: "critic-thread-preview-count",
			text: data.countLabel,
		});
		if (data.resolved) {
			header.createSpan({
				cls: "critic-thread-preview-badge",
				text: "Resolved",
			});
		}
		element.createDiv({
			cls: "critic-thread-preview-anchor",
			text: normalizeWhitespace(data.anchorText),
		});
		element.createDiv({
			cls: "critic-thread-preview-message",
			text: data.snippet,
		});
		const metaParts = [
			data.author,
			data.date,
			data.moreLabel,
		].filter((part): part is string => Boolean(part));
		if (metaParts.length > 0) {
			element.createDiv({
				cls: "critic-thread-preview-meta",
				text: metaParts.join(" · "),
			});
		}
		return element;
	}

	private positionThreadPreview(
		element: HTMLElement,
		anchorRect: ClientRectLike,
	): void {
		const margin = 12;
		const gap = 8;
		const width = Math.min(360, Math.max(280, window.innerWidth - margin * 2));
		element.style.width = `${width}px`;
		const previewRect = element.getBoundingClientRect();
		let left = anchorRect.left;
		if (left + width > window.innerWidth - margin) {
			left = window.innerWidth - width - margin;
		}
		left = Math.max(margin, left);

		let top = anchorRect.bottom + gap;
		if (top + previewRect.height > window.innerHeight - margin) {
			top = anchorRect.top - previewRect.height - gap;
		}
		top = Math.max(margin, top);
		element.style.left = `${Math.round(left)}px`;
		element.style.top = `${Math.round(top)}px`;
	}

	getCurrentReviewerIdentity(): ReviewerIdentity {
		return this.getCurrentRelayIdentity() ?? fallbackIdentity();
	}

	getReviewerIdentityForMark(
		mark: CriticMark,
		filePath?: string | null,
	): ReviewerIdentity {
		// A persisted Relay user ID is the strongest signal: it survives
		// display-name changes and needs no attribution guessing.
		const metadataAuthorId = mark.metadata?.authorId?.trim();
		if (metadataAuthorId) {
			const resolved = this.resolveRelayUserById(metadataAuthorId);
			if (resolved) return resolved;
		}
		const metadataAuthor = mark.metadata?.author?.trim();
		const resolvedFilePath =
			filePath ?? this.app.workspace.getActiveFile()?.path ?? null;
		const relayIdentity = this.getRelayIdentityForRange(
			resolvedFilePath,
			mark.contentFrom,
			mark.contentTo,
		);
		if (
			relayIdentity &&
			(!metadataAuthor || isSameReviewerName(relayIdentity.name, metadataAuthor))
		) {
			return relayIdentity;
		}
		if (metadataAuthor) {
			const currentRelayIdentity = this.getCurrentRelayIdentity();
			if (
				currentRelayIdentity &&
				isSameReviewerName(currentRelayIdentity.name, metadataAuthor)
			) {
				return currentRelayIdentity;
			}
			return { name: metadataAuthor, source: "metadata" };
		}
		return relayIdentity ?? fallbackIdentity();
	}

	private buildThreadPreviewData(
		filePath: string,
		from: number,
		to: number,
	): ThreadPreviewData | null {
		const view = this.getMarkdownViewByPath(filePath);
		const editor = view?.editor;
		if (!view?.file || view.file.path !== filePath || !editor) return null;
		const text = editor.getValue();
		const marks = parseCriticMarkup(text)
			.filter((mark) => mark.valid)
			.sort((a, b) => a.from - b.from || a.to - b.to);
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
			if (mark.from !== from || mark.to !== to) continue;

			const run = mark.type === "comment" ? [mark, ...attached] : attached;
			const visibleComments = run.filter(
				(comment) => comment.content.trim().length > 0,
			);
			if (visibleComments.length === 0) return null;
			const firstComment = visibleComments[0];
			const identity = this.getReviewerIdentityForMark(firstComment, filePath);
			const resolved = [mark, ...visibleComments].some(
				(candidate) => candidate.metadata?.resolved === "true",
			);
			return {
				label: resolved
					? "Resolved comment"
					: isSuggestionMark(mark)
						? "Comment on suggestion"
						: "Comment",
				countLabel: `${visibleComments.length} ${
					visibleComments.length === 1 ? "comment" : "comments"
				}`,
				anchorText: getPreviewAnchorText(mark, text, marks),
				snippet: clampPreviewSnippet(firstComment.content),
				moreLabel:
					visibleComments.length > 1
						? `+${visibleComments.length - 1} ${
								visibleComments.length === 2 ? "reply" : "replies"
							}`
						: null,
				author: identity.source === "fallback" ? null : identity.name,
				date: formatMarkDate(firstComment),
				resolved,
			};
		}
		return null;
	}

	private showCommentPreviewAtCursor(editor: Editor): void {
		const file = this.getCurrentMarkdownView()?.file;
		if (!file) {
			new Notice("Open a Markdown note to preview comments.");
			return;
		}
		const mark = getCurrentMark(editor);
		if (!mark?.valid) {
			new Notice("No comment thread at the cursor.");
			return;
		}
		const cm = this.getCodeMirrorEditor(editor);
		const anchor = cm ? this.getRenderedRangeElement(cm, mark.from, mark.to) : null;
		const rect =
			anchor?.getBoundingClientRect() ??
			this.getEditorOffsetRect(editor, mark.contentFrom, mark.contentTo, cm);
		if (!rect) {
			new Notice("No visible comment anchor at the cursor.");
			return;
		}
		const shown = this.showThreadPreview(file.path, mark.from, mark.to, rect, {
			anchor,
			returnFocus: () => editor.focus(),
			role: "dialog",
		});
		if (!shown) {
			new Notice("No comment thread at the cursor.");
		}
	}

	private getEditorOffsetRect(
		editor: Editor,
		fromOffset: number,
		toOffset: number,
		cm: CodeMirrorAdapter | null = this.getCodeMirrorEditor(editor),
	): ClientRectLike | null {
		if (!cm) return null;
		const start = cm.coordsAtPos(fromOffset);
		const end = cm.coordsAtPos(Math.max(fromOffset, toOffset - 1));
		if (!start && !end) return null;
		if (!start) return end;
		if (!end) return start;
		return {
			top: Math.min(start.top, end.top),
			bottom: Math.max(start.bottom, end.bottom),
			left: Math.min(start.left, end.left),
			right: Math.max(start.right, end.right),
		};
	}

	async saveSettingsAndRefresh(): Promise<void> {
		await this.saveData(this.settings);
		this.bumpRenderVersion();
	}

	getActiveReviewState(): ActiveReviewState | null {
		const view = this.getCurrentMarkdownView();
		const file = view?.file;
		const editor = view?.editor;
		if (!file || !editor) return null;

		const marks = parseCriticMarkup(editor.getValue());
		const activeMark = getCurrentMark(editor);
		return {
			file,
			editor,
			marks,
			activeMarkId: activeMark?.id ?? null,
			commentDraft:
				this.commentDraft?.filePath === file.path ? this.commentDraft : null,
		};
	}

	startCommentDraft(
		path: string | null,
		from: number,
		to: number,
		selectedText: string,
	): void {
		const activeFile = this.app.workspace.getActiveFile();
		const filePath = path ?? activeFile?.path;
		if (!filePath) {
			new Notice("Open a Markdown note before adding a comment.");
			return;
		}
		// CriticMarkup can't express overlapping marks.
		const editorText = this.getMarkdownViewByPath(filePath)?.editor.getValue();
		if (
			editorText &&
			parseCriticMarkup(editorText).some(
				(mark) => mark.from < to && mark.to > from,
			)
		) {
			new Notice(
				"That selection already contains a suggestion or comment.",
			);
			return;
		}
		this.lastMarkdownPath = filePath;
		this.commentDraft = { filePath, from, to, selectedText };
		void this.openReviewSidebar();
		this.refreshReviewSidebars();
	}

	startCommentDraftFromEditor(
		editor: Editor,
		info?: MarkdownView | MarkdownFileInfo,
	): void {
		const fromPos = editor.getCursor("from");
		const toPos = editor.getCursor("to");
		const from = editor.posToOffset(fromPos);
		const to = editor.posToOffset(toPos);
		const selectedText = editor.getSelection();
		if (from === to || selectedText.length === 0) {
			new Notice("Select text to comment on.");
			return;
		}
		this.startCommentDraft(info?.file?.path ?? null, from, to, selectedText);
	}

	commitCommentDraft(comment: string): void {
		if (!this.commentDraft) return;
		const draft = this.commentDraft;
		const view = this.getMarkdownViewByPath(draft.filePath);
		const editor = view?.editor;
		const file = view?.file;
		if (!editor || !file || file.path !== draft.filePath) {
			new Notice("Open the commented note before saving this comment.");
			return;
		}
		if (draft.from === draft.to || draft.selectedText.trim().length === 0) {
			new Notice("Select text to comment on.");
			return;
		}
		const commentMarkup = this.formatAttachedCommentMarkup(comment);
		const insertion = `{==${draft.selectedText}==}${commentMarkup}`;
		editor.replaceRange(
			insertion,
			editor.offsetToPos(draft.from),
			editor.offsetToPos(draft.to),
			"relay-comments",
		);
		this.commentDraft = null;
		this.bumpRenderVersion();
	}

	cancelCommentDraft(): void {
		this.commentDraft = null;
		this.refreshReviewSidebars();
	}

	locateMark(mark: CriticMark): void {
		this.locateReviewRange(mark.from, mark.to);
	}

	locateReviewRange(
		fromOffset: number,
		toOffset: number,
		options: { focusEditor?: boolean; select?: boolean } = {},
	): void {
		const view = this.getCurrentMarkdownView();
		const editor = view?.editor;
		if (!editor) return;

		const from = editor.offsetToPos(fromOffset);
		const to = editor.offsetToPos(toOffset);
		const cm = this.getCodeMirrorEditor(editor);
		if (options.select !== false) {
			editor.setSelection(from, to);
		}
		this.centerEditorOffset(editor, fromOffset, toOffset, { from, to }, cm);
		if (options.focusEditor !== false) {
			editor.focus();
		}
		this.refreshReviewSidebars();
	}

	getReviewRangeClientRect(
		fromOffset: number,
		toOffset: number,
	): { top: number; bottom: number; left: number; right: number } | null {
		const view = this.getCurrentMarkdownView();
		const editor = view?.editor;
		const cm = editor ? this.getCodeMirrorEditor(editor) : null;
		if (!cm) return null;

		const renderedElement = this.getRenderedRangeElement(cm, fromOffset, toOffset);
		if (renderedElement) {
			return rectFromElement(renderedElement);
		}

		const start = cm.coordsAtPos(fromOffset);
		const end = cm.coordsAtPos(Math.max(fromOffset, toOffset - 1));
		if (!start && !end) return null;
		if (!start) return end;
		if (!end) return start;
		return {
			top: Math.min(start.top, end.top),
			bottom: Math.max(start.bottom, end.bottom),
			left: Math.min(start.left, end.left),
			right: Math.max(start.right, end.right),
		};
	}

	private centerEditorOffset(
		editor: Editor,
		offset: number,
		toOffset: number,
		range: { from: ReturnType<Editor["offsetToPos"]>; to: ReturnType<Editor["offsetToPos"]> },
		cm: CodeMirrorAdapter | null = this.getCodeMirrorEditor(editor),
	): void {
		if (cm && this.scrollRenderedRangeIntoView(cm, offset, toOffset)) {
			return;
		}
		if (cm?.dispatch) {
			cm.dispatch({
				effects: CodeMirrorEditorView.scrollIntoView(offset, {
					y: "center",
					yMargin: 80,
				}),
			});
			window.requestAnimationFrame(() => {
				this.scrollRenderedRangeIntoView(cm, offset, toOffset);
			});
			return;
		}
		editor.scrollIntoView(range, true);
	}

	private getCodeMirrorEditor(editor: Editor): CodeMirrorAdapter | null {
		return (editor as unknown as { cm?: CodeMirrorAdapter }).cm ?? null;
	}

	private resolveRelayUserById(userId: string): ReviewerIdentity | null {
		const relay = this.getRelayPlugin();
		if (!relay) return null;
		const user =
			relay.relayManager?.users?.get(userId) ??
			relay.sharedFolders?.manager?.users?.get(userId);
		return userToIdentity(user, "relay");
	}

	private getCurrentRelayIdentity(): ReviewerIdentity | null {
		const relay = this.getRelayPlugin();
		const user =
			relay?.loginManager?.user ??
			relay?.relayManager?.user ??
			relay?.sharedFolders?.manager?.user;
		return userToIdentity(user, "relay");
	}

	private getRelayIdentityForRange(
		filePath: string | null,
		fromOffset: number,
		toOffset: number,
	): ReviewerIdentity | null {
		if (!filePath) return null;
		const relay = this.getRelayPlugin();
		const folder = relay?.sharedFolders?.lookup(filePath);
		const ydoc = folder?.proxy?.getDoc(filePath)?.localDoc;
		if (!relay || !folder || !ydoc) return null;

		const userId = this.getDominantRelayUserId(ydoc, fromOffset, toOffset);
		if (!userId) return null;
		return this.resolveRelayUserIdentity(relay, folder, userId);
	}

	private getDominantRelayUserId(
		ydoc: RelayYDocLike,
		fromOffset: number,
		toOffset: number,
	): string | null {
		const clientToUser = new Map<string, string>();
		ydoc.getMap("users").forEach((entry, userId) => {
			const ids = entry.get("ids")?.toArray();
			if (!ids) return;
			for (const clientId of ids) {
				clientToUser.set(String(clientId), userId);
			}
		});

		const counts = new Map<string, number>();
		let pos = 0;
		let item = ydoc.getText("contents")._start ?? null;
		while (item) {
			const length = item.length;
			if (!item.deleted) {
				const start = pos;
				const end = pos + length;
				const overlap = Math.max(
					0,
					Math.min(toOffset, end) - Math.max(fromOffset, start),
				);
				const userId = clientToUser.get(String(item.id?.client));
				if (overlap > 0 && userId) {
					counts.set(userId, (counts.get(userId) ?? 0) + overlap);
				}
				pos = end;
			}
			item = item.right ?? null;
		}

		let bestUserId: string | null = null;
		let bestCount = 0;
		for (const [userId, count] of counts) {
			if (count > bestCount) {
				bestUserId = userId;
				bestCount = count;
			}
		}
		return bestUserId;
	}

	private resolveRelayUserIdentity(
		relay: RelayPluginLike,
		folder: RelaySharedFolderLike,
		userId: string,
	): ReviewerIdentity {
		const user =
			relay.relayManager?.users?.get(userId) ??
			relay.sharedFolders?.manager?.users?.get(userId);
		const identity = userToIdentity(user, "relay");
		if (identity) return identity;

		const displayName = folder.getUserDisplayName?.(userId)?.trim();
		return {
			name: displayName || userId,
			source: "relay",
		};
	}

	private getRelayPlugin(): RelayPluginLike | null {
		const appWithPlugins = this.app as unknown as {
			plugins?: { plugins?: Record<string, unknown> };
		};
		return (
			(appWithPlugins.plugins?.plugins?.["system3-relay"] as
				| RelayPluginLike
				| undefined) ?? null
		);
	}

	private scrollRenderedRangeIntoView(
		cm: CodeMirrorAdapter,
		fromOffset: number,
		toOffset: number,
	): boolean {
		const element = this.getRenderedRangeElement(cm, fromOffset, toOffset);
		if (!element) return false;
		element.scrollIntoView({ block: "center", inline: "nearest" });
		return true;
	}

	private getRenderedRangeElement(
		cm: CodeMirrorAdapter,
		fromOffset: number,
		toOffset: number,
	): HTMLElement | null {
		const root = cm.dom;
		if (!root) return null;

		return (
			Array.from(
				root.querySelectorAll<HTMLElement>("[data-critic-from][data-critic-to]"),
			).find(
				(element) =>
					Number(element.dataset.criticFrom) === fromOffset &&
					Number(element.dataset.criticTo) === toOffset,
			) ?? null
		);
	}

	applyMarkActionFromSidebar(mark: CriticMark, action: CriticAction): void {
		const view = this.getCurrentMarkdownView();
		const editor = view?.editor;
		if (!editor) return;
		replaceMark(editor, mark, action);
		this.refreshReviewSidebars();
		this.bumpRenderVersion();
	}

	replaceReviewRangeFromSidebar(
		fromOffset: number,
		toOffset: number,
		replacement: string,
	): void {
		const view = this.getCurrentMarkdownView();
		const editor = view?.editor;
		if (!editor) return;
		editor.replaceRange(
			replacement,
			editor.offsetToPos(fromOffset),
			editor.offsetToPos(toOffset),
			"relay-comments",
		);
		this.bumpRenderVersion();
	}

	insertReplyToMark(mark: CriticMark, reply: string): boolean {
		const view = this.getCurrentMarkdownView();
		const editor = view?.editor;
		if (!editor) return false;
		const cm = this.getCodeMirrorEditor(editor);
		const scrollTop = cm?.scrollDOM?.scrollTop;
		editor.replaceRange(
			this.formatAttachedCommentMarkup(reply),
			editor.offsetToPos(mark.to),
			undefined,
			"relay-comments",
		);
		this.bumpRenderVersion();
		if (typeof scrollTop === "number" && cm?.scrollDOM) {
			window.requestAnimationFrame(() => {
				if (cm.scrollDOM) {
					cm.scrollDOM.scrollTop = scrollTop;
				}
			});
		}
		return true;
	}

	updateCommentTextFromSidebar(mark: CriticMark, text: string): boolean {
		if (mark.type !== "comment") return false;
		const view = this.getCurrentMarkdownView();
		const editor = view?.editor;
		if (!editor) return false;
		const range = mark.ranges.commentText ?? [mark.contentFrom, mark.contentTo];
		editor.replaceRange(
			sanitizeCommentText(text),
			editor.offsetToPos(range[0]),
			editor.offsetToPos(range[1]),
			"relay-comments",
		);
		this.bumpRenderVersion();
		return true;
	}

	private formatCommentMarkup(comment: string): string {
		const identity = this.getCurrentReviewerIdentity();
		const metadata: string[] = [];
		if (identity.source === "relay" && identity.id) {
			metadata.push(`authorId="${formatMetadataValue(identity.id)}"`);
		}
		metadata.push(
			`author="${formatMetadataValue(identity.name)}"`,
			`date="${new Date().toISOString()}"`,
		);
		return `{{${metadata.join(" ")}>>${sanitizeCommentText(comment)}<<}}`;
	}

	private formatAttachedCommentMarkup(comment: string): string {
		return `${CRITIC_SECTION_SEPARATOR}${this.formatCommentMarkup(comment)}`;
	}

	async openReviewSidebar(): Promise<void> {
		if (this.reviewSidebarOpenPromise) {
			return this.reviewSidebarOpenPromise;
		}

		this.reviewSidebarOpenPromise = this.openReviewSidebarOnce().finally(() => {
			this.reviewSidebarOpenPromise = null;
		});
		return this.reviewSidebarOpenPromise;
	}

	private async openReviewSidebarOnce(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_CRITIC_REVIEW,
		)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;

		await leaf.setViewState({ type: VIEW_TYPE_CRITIC_REVIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
		this.refreshReviewSidebars();
	}

	private async toggleReviewSidebarFromRibbon(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_CRITIC_REVIEW,
		)[0];
		if (existing && this.isReviewSidebarActiveVisible(existing)) {
			this.closeReviewSidebar(existing);
			return;
		}
		await this.openReviewSidebar();
	}

	private isReviewSidebarActiveVisible(leaf: WorkspaceLeaf): boolean {
		const rightSplit = (
			this.app.workspace as typeof this.app.workspace & {
				rightSplit?: { collapsed?: boolean };
			}
		).rightSplit;
		return this.app.workspace.activeLeaf === leaf && rightSplit?.collapsed !== true;
	}

	closeReviewSidebar(leaf?: WorkspaceLeaf): void {
		this.reviewSidebarOpenPromise = null;
		const leaves =
			leaf !== undefined
				? [leaf]
				: this.app.workspace.getLeavesOfType(VIEW_TYPE_CRITIC_REVIEW);
		for (const reviewLeaf of leaves) {
			reviewLeaf.detach();
		}
	}

	refreshReviewSidebars(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_CRITIC_REVIEW,
		)) {
			if (leaf.view instanceof ReviewSidebarView) {
				leaf.view.refresh();
			}
		}
	}

	private async loadSettings(): Promise<void> {
		this.settings = resolveSettings(await this.loadData());
	}

	private registerCommands(): void {
		this.addCommand({
			id: "open-review-sidebar",
			name: "Open review sidebar",
			callback: () => {
				void this.openReviewSidebar();
			},
		});
		this.addCommand({
			id: "close-review-sidebar",
			name: "Close review sidebar",
			callback: () => {
				this.closeReviewSidebar();
			},
		});
		this.addEditorCommand(
			"show-comment-preview-at-cursor",
			"Show comment preview at cursor",
			(editor) => this.showCommentPreviewAtCursor(editor),
		);
		this.addEditorCommand("add-addition", "Mark selection as addition", (editor) =>
			wrapSelection(editor, "addition"),
		);
		this.addEditorCommand("add-deletion", "Mark selection as deletion", (editor) =>
			wrapSelection(editor, "deletion"),
		);
		this.addEditorCommand("add-substitution", "Mark selection as substitution", (editor) =>
			addSubstitution(this.app, editor),
		);
		this.addEditorCommand(
			"add-comment",
			"Add comment",
			(editor) => this.startCommentDraftFromEditor(editor),
			ADD_COMMENT_HOTKEYS,
		);
		this.addEditorCommand("add-highlight", "Highlight selection", (editor) =>
			wrapSelection(editor, "highlight"),
		);
		this.addEditorCommand("accept-current", "Accept current comment or suggestion", (editor) => {
			applyCurrentMarkAction(editor, "accept");
			this.bumpRenderVersion();
		});
		this.addEditorCommand("reject-current", "Reject current comment or suggestion", (editor) => {
			applyCurrentMarkAction(editor, "reject");
			this.bumpRenderVersion();
		});
		this.addEditorCommand("accept-all", "Accept all comments and suggestions", (editor) => {
			applyAllInEditor(editor, "accept");
			this.bumpRenderVersion();
		});
		this.addEditorCommand("reject-all", "Reject all comments and suggestions", (editor) => {
			applyAllInEditor(editor, "reject");
			this.bumpRenderVersion();
		});
		this.addEditorCommand("finalize-for-publish", "Finalize for publish", (editor) => {
			applyAllInEditor(editor, "accept");
			this.bumpRenderVersion();
		});
	}

	private addEditorCommand(
		id: string,
		name: string,
		callback: (editor: Editor) => void | Promise<void>,
		hotkeys?: Hotkey[],
	): void {
		this.addCommand({
			id,
			name,
			hotkeys,
			editorCallback: async (editor) => {
				await callback(editor);
				this.refreshReviewSidebars();
			},
		});
	}

	private registerWorkspaceEvents(): void {
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, info) => {
				this.addEditorMenuItems(menu, editor, info);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", () => {
				this.captureActiveMarkdownPath();
				this.hideThreadPreview();
				this.refreshReviewSidebars();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.captureActiveMarkdownPath();
				this.hideThreadPreview();
				this.queueEditorExtensionRefresh(0);
				this.refreshReviewSidebars();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				this.captureActiveMarkdownPath();
				this.hideThreadPreview();
				this.queueEditorExtensionRefresh(0);
				this.refreshReviewSidebars();
			}),
		);
	}

	private addEditorMenuItems(
		menu: Menu,
		editor: Editor,
		info: MarkdownView | MarkdownFileInfo,
	): void {
		menu.addSeparator();
		menu.addItem((item) => {
			item
				.setTitle("Add comment")
				.setIcon("message-square-plus")
				.setDisabled(!editor.somethingSelected())
				.onClick(() => {
					this.startCommentDraftFromEditor(editor, info);
				});
		});
	}

	private captureActiveMarkdownPath(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file) {
			this.lastMarkdownPath = view.file.path;
		}
	}

	private getCurrentMarkdownView(): MarkdownView | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file) {
			this.lastMarkdownPath = active.file.path;
			return active;
		}
		if (this.lastMarkdownPath) {
			const byPath = this.getMarkdownViewByPath(this.lastMarkdownPath);
			if (byPath) return byPath;
		}
		let fallback: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!fallback && leaf.view instanceof MarkdownView && leaf.view.file) {
				fallback = leaf.view;
			}
		});
		const resolved = fallback as MarkdownView | null;
		if (resolved?.file) {
			this.lastMarkdownPath = resolved.file.path;
		}
		return resolved;
	}

	private getMarkdownViewByPath(path: string): MarkdownView | null {
		let found: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (found) return;
			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) {
				found = leaf.view;
			}
		});
		return found;
	}

	private bumpRenderVersion(): void {
		this.renderVersion += 1;
		this.refreshOpenEditors();
		this.refreshReviewSidebars();
		this.app.workspace.updateOptions();
	}

	private queueEditorExtensionRefresh(delayMs: number): void {
		const timer = window.setTimeout(() => {
			this.app.workspace.updateOptions();
			this.refreshOpenEditors();
		}, delayMs);
		this.register(() => window.clearTimeout(timer));
	}

	private refreshOpenEditors(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			const editor = leaf.view.editor;
			const cm = (editor as unknown as { cm?: { dispatch(spec?: object): void } }).cm;
			if (cm?.dispatch) {
				cm.dispatch({});
			} else {
				editor.refresh();
			}
		});
	}
}

function rectFromElement(element: HTMLElement): ClientRectLike {
	const rect = element.getBoundingClientRect();
	return {
		top: rect.top,
		bottom: rect.bottom,
		left: rect.left,
		right: rect.right,
	};
}

function userToIdentity(
	user: RelayUserLike | undefined,
	source: ReviewerIdentity["source"],
): ReviewerIdentity | null {
	const name = user?.name?.trim();
	if (!user || !name) return null;
	const color =
		typeof user.color === "string" ? user.color : user.color?.color;
	const colorLight =
		user.colorLight ??
		(typeof user.color === "string" ? undefined : user.color?.light);
	return {
		id: user.id,
		name,
		picture: user.picture,
		color,
		colorLight,
		source,
	};
}

function isSameReviewerName(left: string, right: string): boolean {
	return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function formatMetadataValue(value: string): string {
	return value.replace(/"/g, "'");
}

function sanitizeCommentText(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		// Blank lines would split the note into separate Markdown sections
		// around an inline comment; keep single line breaks.
		.replace(/[\t ]*\n[\t ]*\n[\t \n]*/g, "\n")
		// "<<}" inside a comment body would close the mark early.
		.replace(/<<(?=\})/g, "<< ")
		.trim();
}

function fallbackIdentity(): ReviewerIdentity {
	return {
		name: "Unknown author",
		source: "fallback",
	};
}
