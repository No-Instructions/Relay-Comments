import type { CliData } from "obsidian";
import { CliError } from "./types";

/** A value flag; a bare flag (value "true") counts as missing. */
export function optional(params: CliData, key: string): string | undefined {
	const value = params[key];
	if (value === undefined || value === "true") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

export function required(params: CliData, key: string): string {
	const value = optional(params, key);
	if (value === undefined) {
		throw new CliError(
			"missing_flag",
			`Missing required parameter: ${key}=<value>`,
		);
	}
	return value;
}

/** A boolean flag: present means on; `key=off` means off. */
export function flag(params: CliData, key: string): boolean {
	const value = params[key];
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	if (["true", "on", "yes", "1"].includes(normalized)) return true;
	if (["false", "off", "no", "0"].includes(normalized)) return false;
	throw new CliError("invalid_value", `${key} must be on or off, got "${value}"`);
}

/** A non-negative number flag, or undefined when absent. */
export function number(params: CliData, key: string): number | undefined {
	const value = optional(params, key);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new CliError("invalid_value", `${key} must be a non-negative number, got "${value}"`);
	}
	return parsed;
}

/**
 * A text flag, kept verbatim: leading and trailing spaces matter in an
 * insertion or a quote. Literal `\n` and `\t` sequences become newlines
 * and tabs, the CLI's convention for multi-line values.
 */
export function text(params: CliData, key: string): string {
	const value = params[key];
	if (value === undefined || value === "true" || value.trim() === "") {
		throw new CliError("missing_flag", `Missing required parameter: ${key}=<value>`);
	}
	return value.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

/** A vault-relative path with forward slashes and no leading slash. */
export function vaultPath(input: string): string {
	return input
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
}
