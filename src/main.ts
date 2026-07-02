import {
	MarkdownView,
	Notice,
	Plugin,
	type Editor,
	type MarkdownFileInfo,
	type Menu,
	type TFile,
	type WorkspaceLeaf,
} from "obsidian";
import { EditorView as CodeMirrorEditorView } from "@codemirror/view";
import { parseCriticMarkup } from "./critic/parse";
import type { CriticAction } from "./critic/transform";
import type { CriticMark, DisplayMode } from "./critic/types";
import {
	applyAllInEditor,
	applyCurrentMarkAction,
	replaceMark,
	wrapSelection,
	addSubstitution,
	getCurrentMark,
} from "./editor/commands";
import {
	createCriticMarkupExtension,
	type CriticMarkupEditorController,
} from "./editor/extension";
import { createCriticMarkupPostProcessor } from "./preview/postprocessor";
import {
	DEFAULT_SETTINGS,
	CriticMarkupSettingTab,
	type CriticMarkupSettings,
} from "./settings";
import {
	ReviewSidebarView,
	VIEW_TYPE_CRITIC_REVIEW,
} from "./ui/ReviewSidebarView";
import { promptText } from "./ui/PromptModal";

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

interface RelayUserLike {
	id?: string;
	name?: string;
	email?: string;
	picture?: string;
	color?: { color?: string; light?: string };
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

export default class CriticMarkupPlugin
	extends Plugin
	implements CriticMarkupEditorController
{
	settings!: CriticMarkupSettings;
	private renderVersion = 0;
	private commentDraft: CommentDraft | null = null;
	private lastMarkdownPath: string | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_CRITIC_REVIEW,
			(leaf: WorkspaceLeaf) => new ReviewSidebarView(leaf, this),
		);
		this.registerEditorExtension(createCriticMarkupExtension(this));
		this.app.workspace.updateOptions();
		this.registerMarkdownPostProcessor(createCriticMarkupPostProcessor(this));
		this.addSettingTab(new CriticMarkupSettingTab(this.app, this));

		this.addRibbonIcon("message-square-text", "Open CriticMarkup review", () => {
			void this.openReviewSidebar();
		});

		this.registerCommands();
		this.registerWorkspaceEvents();
		this.queueEditorExtensionRefresh(0);
		this.queueEditorExtensionRefresh(250);

		this.app.workspace.onLayoutReady(() => {
			void this.ensureReviewSidebarTab();
			this.queueEditorExtensionRefresh(0);
			this.queueEditorExtensionRefresh(250);
			this.refreshReviewSidebars();
		});
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_CRITIC_REVIEW);
		this.app.workspace.updateOptions();
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

		void this.openReviewSidebar().then(() => {
			activate(this.app.workspace.getLeavesOfType(VIEW_TYPE_CRITIC_REVIEW)[0]);
		});
	}

	getCurrentReviewerIdentity(): ReviewerIdentity {
		return this.getCurrentRelayIdentity() ?? fallbackIdentity();
	}

	getReviewerIdentityForMark(
		mark: CriticMark,
		filePath?: string | null,
	): ReviewerIdentity {
		const metadataAuthor = mark.metadata?.author?.trim();
		if (metadataAuthor) {
			return { name: metadataAuthor, source: "metadata" };
		}

		const relayIdentity = this.getRelayIdentityForRange(
			filePath ?? this.app.workspace.getActiveFile()?.path ?? null,
			mark.contentFrom,
			mark.contentTo,
		);
		return relayIdentity ?? fallbackIdentity();
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
		const commentMarkup = this.formatCommentMarkup(comment);
		const insertion = `{==${draft.selectedText}==}${commentMarkup}`;
		editor.replaceRange(
			insertion,
			editor.offsetToPos(draft.from),
			editor.offsetToPos(draft.to),
			"criticmarkup",
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
			"criticmarkup",
		);
		this.bumpRenderVersion();
	}

	async replyToMark(mark: CriticMark): Promise<void> {
		const view = this.getCurrentMarkdownView();
		const editor = view?.editor;
		if (!editor) return;
		const reply = await promptText(this.app, "Reply", {
			placeholder: "Write a reply",
			submitText: "Insert reply",
		});
		if (reply === null || reply.length === 0) return;
		editor.replaceRange(
			this.formatCommentMarkup(reply),
			editor.offsetToPos(mark.to),
			undefined,
			"criticmarkup",
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
			this.formatCommentMarkup(reply),
			editor.offsetToPos(mark.to),
			undefined,
			"criticmarkup",
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
			text,
			editor.offsetToPos(range[0]),
			editor.offsetToPos(range[1]),
			"criticmarkup",
		);
		this.bumpRenderVersion();
		return true;
	}

	private formatCommentMarkup(comment: string): string {
		const identity = this.getCurrentReviewerIdentity();
		const metadata = [
			`author="${formatMetadataValue(identity.name)}"`,
			`date="${new Date().toISOString()}"`,
		].join(" ");
		return `{{${metadata}>>${comment}<<}}`;
	}

	async openReviewSidebar(): Promise<void> {
		if (!this.settings.enableReviewSidebar) {
			new Notice("Enable the CriticMarkup review sidebar in settings.");
			return;
		}

		const existing = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_CRITIC_REVIEW,
		)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;

		await leaf.setViewState({ type: VIEW_TYPE_CRITIC_REVIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
		this.refreshReviewSidebars();
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
		const loaded = await this.loadData();
		this.settings = {
			showAuthorChips:
				loaded?.showAuthorChips ?? DEFAULT_SETTINGS.showAuthorChips,
			showInlineActions:
				loaded?.showInlineActions ?? DEFAULT_SETTINGS.showInlineActions,
			enableReviewSidebar:
				loaded?.enableReviewSidebar ?? DEFAULT_SETTINGS.enableReviewSidebar,
		};
	}

	private registerCommands(): void {
		this.addCommand({
			id: "open-review-sidebar",
			name: "Open review sidebar",
			callback: () => {
				void this.openReviewSidebar();
			},
		});
		this.addEditorCommand("add-addition", "Mark selection as addition", (editor) =>
			wrapSelection(editor, "addition"),
		);
		this.addEditorCommand("add-deletion", "Mark selection as deletion", (editor) =>
			wrapSelection(editor, "deletion"),
		);
		this.addEditorCommand("add-substitution", "Mark selection as substitution", (editor) =>
			addSubstitution(this.app, editor),
		);
		this.addEditorCommand("add-comment", "Add comment", (editor) =>
			this.startCommentDraftFromEditor(editor),
		);
		this.addEditorCommand("add-highlight", "Highlight selection", (editor) =>
			wrapSelection(editor, "highlight"),
		);
		this.addEditorCommand("accept-current", "Accept current CriticMarkup mark", (editor) => {
			applyCurrentMarkAction(editor, "accept");
			this.bumpRenderVersion();
		});
		this.addEditorCommand("reject-current", "Reject current CriticMarkup mark", (editor) => {
			applyCurrentMarkAction(editor, "reject");
			this.bumpRenderVersion();
		});
		this.addEditorCommand("accept-all", "Accept all CriticMarkup marks", (editor) => {
			applyAllInEditor(editor, "accept");
			this.bumpRenderVersion();
		});
		this.addEditorCommand("reject-all", "Reject all CriticMarkup marks", (editor) => {
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
	): void {
		this.addCommand({
			id,
			name,
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
				this.refreshReviewSidebars();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.captureActiveMarkdownPath();
				this.queueEditorExtensionRefresh(0);
				this.refreshReviewSidebars();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				this.captureActiveMarkdownPath();
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
				.setTitle("Add CriticMarkup comment")
				.setIcon("message-square-plus")
				.setDisabled(!editor.somethingSelected())
				.onClick(() => {
					this.startCommentDraftFromEditor(editor, info);
				});
		});
	}

	private async ensureReviewSidebarTab(): Promise<void> {
		if (!this.settings.enableReviewSidebar) return;
		if (this.app.workspace.getLeavesOfType(VIEW_TYPE_CRITIC_REVIEW).length > 0) {
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_CRITIC_REVIEW, active: false });
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
	return {
		name,
		picture: user.picture,
		color: user.color?.color,
		colorLight: user.color?.light,
		source,
	};
}

function formatMetadataValue(value: string): string {
	return value.replace(/"/g, "'");
}

function fallbackIdentity(): ReviewerIdentity {
	return {
		name: "Reviewer",
		source: "fallback",
	};
}
