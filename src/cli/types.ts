import type { CliData, CliFlags } from "obsidian";
import type { Identity } from "../identity/types";
import type { CanvasDoc } from "./canvas";
import type { ReviewEventLog } from "./events";

export type CliFormat = "text" | "json";

/**
 * A failure the CLI reports as an envelope instead of a thrown error. The
 * Obsidian CLI exits 0 whatever the handler does, so callers read `ok`.
 */
export class CliError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly extra: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "CliError";
	}
}

export interface CliResult {
	/** Machine payload. Objects merge under `ok: true`; arrays become `items`. */
	data: Record<string, unknown> | unknown[];
	/** Human rendering for `format=text`. */
	text: string;
}

export interface CliCommand {
	id: string;
	description: string;
	flags: CliFlags | null;
	run(params: CliData, ctx: CliContext): Promise<CliResult> | CliResult;
}

/**
 * One replacement against the text a planner was handed. Offsets are
 * UTF-16 indices into that exact text; a plan's changes never overlap.
 */
export interface TextChange {
	from: number;
	to: number;
	insert: string;
}

/**
 * Whether a write is the user's own. The user's edits are ordinary undo
 * steps; an edit signed as anyone else (an agent with its own identity, a
 * named reviewer) behaves like a collaborator's change and stays out of
 * the user's undo history.
 */
export interface EditOptions {
	asUser: boolean;
}

export interface CliNoteAccess {
	/** The vault path of an existing Markdown note, from user input. */
	resolve(input: string): string | null;
	/** True when the input names a folder in the vault. */
	isFolder(input: string): boolean;
	/** Markdown notes under a folder, or every note for `null`. */
	list(scope: string | null): string[];
	/** The vault path of an existing note or canvas, from user input. */
	resolveWatchable(input: string): string | null;
	/** Notes and canvases under a folder, or all of them for `null`. */
	watchable(scope: string | null): string[];
	/**
	 * The live contents: the editor buffer of an open note, the current
	 * data of an open canvas, otherwise disk.
	 */
	read(path: string): Promise<string | null>;
	/**
	 * Plan changes against the freshest text and apply them in one step:
	 * through the open editor when there is one, so collaboration and undo
	 * see an ordinary edit, and through the vault otherwise.
	 */
	edit(path: string, plan: (text: string) => TextChange[], options?: EditOptions): Promise<void>;
	/**
	 * Update a canvas from its freshest data in one step: through the open
	 * canvas view when there is one, as the pin UI saves, and through the
	 * vault otherwise.
	 */
	editCanvas(
		path: string,
		update: (doc: CanvasDoc) => CanvasDoc,
		options?: EditOptions,
	): Promise<void>;
}

export interface CliIdentity {
	id?: string;
	name?: string;
	source: string;
}

/** Everything a command may reach. Narrow on purpose so tests can fake it. */
export interface CliContext {
	version: string;
	notes: CliNoteAccess;
	events: ReviewEventLog;
	/** The identity the plugin would sign a comment with in this note. */
	identity(path: string): Promise<CliIdentity>;
	/** The configured identity directory (`identities` in data.json). */
	identities(): Identity[];
	now(): Date;
}
