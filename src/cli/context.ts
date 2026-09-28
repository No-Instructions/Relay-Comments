import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { TFile, TFolder, normalizePath } from "obsidian";
import { READ_ONLY_NOTICE } from "../editor/access";
import type RelayCommentsPlugin from "../main";
import { isWatchablePath, type EventTimers, type ReviewEventLog } from "./events";
import { createReviewEventFeed, type ReviewEventFeed } from "./feed";
import { parseCanvas, rebaseCanvasSnapshot, serializeCanvas, type CanvasDoc } from "./canvas";
import { vaultPath } from "./params";
import { applyChanges } from "./threads";
import { CliError, type CliContext } from "./types";

function underScope(scope: string | null, path: string): boolean {
	if (scope === null || scope === "") return true;
	return path === scope || path.startsWith(`${scope}/`);
}

export const windowTimers: EventTimers = {
	setTimeout: (callback, ms) => window.setTimeout(callback, ms),
	clearTimeout: (id) => window.clearTimeout(id),
};

/** Bind the command context to the live plugin. Reads stay live through closures. */
export function buildCliContext(
	plugin: RelayCommentsPlugin,
	events: ReviewEventLog,
): CliContext {
	const { app } = plugin;

	const fileFor = (input: string, extensions: string[] = ["md"]): TFile | null => {
		const normalized = normalizePath(vaultPath(input));
		if (normalized === "" || normalized === "/") return null;
		const lower = normalized.toLowerCase();
		const candidates = extensions.some((extension) => lower.endsWith(`.${extension}`))
			? [normalized]
			: [...extensions.map((extension) => `${normalized}.${extension}`), normalized];
		for (const candidate of candidates) {
			const file = app.vault.getAbstractFileByPath(candidate);
			if (file instanceof TFile && extensions.includes(file.extension)) return file;
		}
		return null;
	};

	interface OpenCanvas {
		file?: TFile | null;
		getViewData?: () => string;
		canvas?: {
			getData(): CanvasDoc;
			importData(data: CanvasDoc, clear?: boolean): void;
			requestSave(pushHistory?: boolean): void;
			history?: { data: CanvasDoc[] };
		};
	}

	const openCanvasView = (path: string): OpenCanvas | null => {
		let found: OpenCanvas | null = null;
		app.workspace.iterateAllLeaves((leaf) => {
			if (found !== null || leaf.view.getViewType() !== "canvas") return;
			const view = leaf.view as typeof leaf.view & OpenCanvas;
			if (view.file?.path === path) found = view;
		});
		return found;
	};

	/** An open canvas's current data, which can be ahead of its saved file. */
	const openCanvasData = (path: string): string | null => {
		const view = openCanvasView(path);
		return view && typeof view.getViewData === "function" ? view.getViewData() : null;
	};

	return {
		get version() {
			return plugin.manifest.version;
		},
		notes: {
			resolve: (input) => fileFor(input)?.path ?? null,
			isFolder: (input) => {
				const path = vaultPath(input);
				if (path === "") return true;
				return app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFolder;
			},
			list: (scope) =>
				app.vault
					.getMarkdownFiles()
					.filter((file) => underScope(scope, file.path))
					.map((file) => file.path),
			resolveWatchable: (input) => fileFor(input, ["md", "canvas"])?.path ?? null,
			watchable: (scope) =>
				app.vault
					.getFiles()
					.filter((file) => isWatchablePath(file.path) && underScope(scope, file.path))
					.map((file) => file.path),
			read: async (path) => {
				if (path.toLowerCase().endsWith(".canvas")) {
					const live = openCanvasData(path);
					if (live !== null) return live;
					const canvas = fileFor(path, ["canvas"]);
					return canvas ? app.vault.cachedRead(canvas) : null;
				}
				const view = plugin.findOpenMarkdownView(path);
				if (view) return view.editor.getValue();
				const file = fileFor(path);
				return file ? app.vault.cachedRead(file) : null;
			},
			edit: async (path, plan, options = { asUser: true }) => {
				const view = plugin.findOpenMarkdownView(path);
				if (view) {
					const { editor } = view;
					if (plugin.noteEditorIsReadOnly(editor)) {
						throw new CliError("read_only", READ_ONLY_NOTICE);
					}
					const changes = plan(editor.getValue());
					if (changes.length === 0) return;
					const cm = (editor as unknown as { cm?: EditorView }).cm;
					if (!options.asUser && cm) {
						// Someone else's edit: mapped through the user's history
						// like a collaborator's, never undone by the user's Ctrl+Z.
						cm.dispatch({
							changes: changes.map((change) => ({
								from: change.from,
								to: change.to,
								insert: change.insert,
							})),
							annotations: [
								Transaction.addToHistory.of(false),
								Transaction.userEvent.of("relay-comments"),
							],
						});
						plugin.refreshReviewSidebars();
						return;
					}
					editor.transaction(
						{
							changes: changes.map((change) => ({
								from: editor.offsetToPos(change.from),
								to: editor.offsetToPos(change.to),
								text: change.insert,
							})),
						},
						"relay-comments",
					);
					plugin.refreshReviewSidebars();
					return;
				}
				const file = fileFor(path);
				if (!file) {
					throw new CliError("note_not_found", `No Markdown note at ${path}`);
				}
				await app.vault.process(file, (data) => applyChanges(data, plan(data)));
			},
			editCanvas: async (path, update, options = { asUser: true }) => {
				const live = openCanvasView(path)?.canvas;
				if (live) {
					const before = parseCanvas(JSON.stringify(live.getData()));
					const after = update(parseCanvas(JSON.stringify(before)));
					live.importData(after, true);
					if (options.asUser || !live.history) {
						live.requestSave();
						return;
					}
					// Someone else's edit: no undo step of its own, and replayed
					// into every snapshot the user can step back to, since canvas
					// undo restores whole snapshots.
					live.history.data = live.history.data.map((snapshot) =>
						rebaseCanvasSnapshot(snapshot, before, after),
					);
					live.requestSave(false);
					return;
				}
				const file = fileFor(path, ["canvas"]);
				if (!file) {
					throw new CliError("note_not_found", `No canvas at ${path}`);
				}
				await app.vault.process(file, (data) => serializeCanvas(update(parseCanvas(data))));
			},
		},
		events,
		identity: async (path) => {
			const target = path || app.workspace.getActiveFile()?.path || "";
			const identity = await plugin.getCurrentReviewerIdentityAsync(target);
			if (identity.source === "fallback") return { source: "fallback" };
			return { id: identity.id, name: identity.name, source: identity.source };
		},
		identities: () => plugin.settings.identities,
		now: () => new Date(),
	};
}

/**
 * Feed vault and editor changes into the event log for the plugin's
 * lifetime. Editor changes arrive before the autosave, so an open note
 * reports a new comment within the quiet period rather than on save.
 * The feed drops notes outside every watched scope before reading them.
 */
export function attachReviewEventFeed(
	plugin: RelayCommentsPlugin,
	ctx: CliContext,
): ReviewEventFeed {
	const feed = createReviewEventFeed({
		events: ctx.events,
		read: (path) => ctx.notes.read(path),
		timers: windowTimers,
	});
	const isNote = (file: unknown): file is TFile =>
		file instanceof TFile && isWatchablePath(file.path);
	const { vault, workspace } = plugin.app;
	plugin.registerEvent(
		vault.on("modify", (file) => {
			if (isNote(file)) feed.noteChanged(file.path);
		}),
	);
	plugin.registerEvent(
		vault.on("create", (file) => {
			if (isNote(file)) feed.noteChanged(file.path);
		}),
	);
	plugin.registerEvent(
		vault.on("delete", (file) => {
			if (isNote(file)) feed.noteDeleted(file.path);
		}),
	);
	plugin.registerEvent(
		vault.on("rename", (file, oldPath) => {
			if (isNote(file)) feed.noteRenamed(oldPath, file.path);
		}),
	);
	plugin.registerEvent(
		workspace.on("editor-change", (_editor, info) => {
			const path = info.file?.path;
			if (path && isWatchablePath(path)) feed.noteChanged(path);
		}),
	);
	return feed;
}
