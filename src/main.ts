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
		const insertion =
			draft.from === draft.to
				? `{>>${comment}<<}`
				: `{==${draft.selectedText}==}{>>${comment}<<}`;
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
		if (options.select !== false) {
			editor.setSelection(from, to);
		}
		this.centerEditorOffset(editor, fromOffset, { from, to });
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
		const cm = (editor as unknown as {
			cm?: {
				coordsAtPos(pos: number): {
					top: number;
					bottom: number;
					left: number;
					right: number;
				} | null;
			};
		} | null)?.cm;
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

	private centerEditorOffset(
		editor: Editor,
		offset: number,
		range: { from: ReturnType<Editor["offsetToPos"]>; to: ReturnType<Editor["offsetToPos"]> },
	): void {
		const cm = (editor as unknown as {
			cm?: { dispatch(spec?: { effects?: unknown }): void };
		}).cm;
		if (cm?.dispatch) {
			cm.dispatch({
				effects: CodeMirrorEditorView.scrollIntoView(offset, {
					y: "center",
					yMargin: 80,
				}),
			});
			return;
		}
		editor.scrollIntoView(range, true);
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
			`{>>${reply}<<}`,
			editor.offsetToPos(mark.to),
			undefined,
			"criticmarkup",
		);
		this.bumpRenderVersion();
	}

	insertReplyToMark(mark: CriticMark, reply: string): void {
		const view = this.getCurrentMarkdownView();
		const editor = view?.editor;
		if (!editor) return;
		editor.replaceRange(
			`{>>${reply}<<}`,
			editor.offsetToPos(mark.to),
			undefined,
			"criticmarkup",
		);
		this.bumpRenderVersion();
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
