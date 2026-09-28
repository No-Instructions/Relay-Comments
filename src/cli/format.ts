import { CliError, type CliFormat, type CliResult } from "./types";

export function cell(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint") return value.toString();
	return JSON.stringify(value);
}

/** "key: value" lines, skipping undefined values. */
export function kv(entries: [string, unknown][]): string {
	return entries
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}: ${cell(value)}`)
		.join("\n");
}

/** One line of text, shortened with an ellipsis past `max` characters. */
export function clip(value: string, max = 120): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function renderOk(result: CliResult, format: CliFormat): string {
	if (format !== "json") return result.text;
	const payload = Array.isArray(result.data)
		? { ok: true, items: result.data }
		: { ok: true, ...result.data };
	return JSON.stringify(payload, null, 2);
}

export function renderError(error: unknown, format: CliFormat): string {
	const cliError =
		error instanceof CliError
			? error
			: new CliError(
					"error",
					error instanceof Error ? error.message : String(error),
				);
	if (format === "json") {
		return JSON.stringify(
			{
				ok: false,
				code: cliError.code,
				message: cliError.message,
				...cliError.extra,
			},
			null,
			2,
		);
	}
	const lines = [`Error: ${cliError.message}`];
	const candidates = cliError.extra.candidates;
	if (Array.isArray(candidates) && candidates.length > 0) {
		lines.push("Candidates:");
		for (const candidate of candidates) {
			lines.push(`  ${cell(candidate)}`);
		}
	}
	return lines.join("\n");
}

export function formatOf(params: Record<string, string>): CliFormat {
	return params.format === "json" ? "json" : "text";
}
