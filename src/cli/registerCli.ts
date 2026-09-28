import type { CliData, CliFlags, CliHandler } from "obsidian";
import { CLI_COMMANDS } from "./commands";
import { formatOf, renderError, renderOk } from "./format";
import type { CliCommand, CliContext } from "./types";

/**
 * Declaring `format` with this value lets the Obsidian CLI accept a bare
 * `--json` and rewrite it to `format=json` before the handler runs. The
 * value deliberately omits `text`: the CLI treats every listed value as a
 * shortcut flag and would swallow a `text=` parameter as `--text`.
 */
const FORMAT_FLAG: CliFlags = {
	format: { value: "json", description: "Output JSON instead of text" },
};

/**
 * The registrar surface of a plugin on an app that exposes the CLI
 * (Obsidian 1.12.2 and later). Declared structurally: the caller confirms
 * the method exists at runtime before handing the plugin over, so an older
 * app never reaches this module.
 */
export interface CliRegistrar {
	registerCliHandler(
		command: string,
		description: string,
		flags: CliFlags | null,
		handler: CliHandler,
	): void;
}

/** A handler never throws: failures come back as an envelope in the chosen format. */
export function cliHandler(command: CliCommand, ctx: CliContext): CliHandler {
	return async (params: CliData): Promise<string> => {
		const format = formatOf(params);
		try {
			return renderOk(await command.run(params, ctx), format);
		} catch (error) {
			return renderError(error, format);
		}
	};
}

export function registerRelayCommentsCli(
	plugin: CliRegistrar,
	ctx: CliContext,
	commands: CliCommand[] = CLI_COMMANDS,
): string[] {
	const registered: string[] = [];
	for (const command of commands) {
		plugin.registerCliHandler(
			command.id,
			command.description,
			{ ...(command.flags ?? {}), ...FORMAT_FLAG },
			cliHandler(command, ctx),
		);
		registered.push(command.id);
	}
	return registered;
}
