import { readFileSync } from "node:fs";

// Obsidian's app.css sets `body { user-select: none }`, so a plugin view's
// text cannot be selected unless the plugin opts back in. Readers copy
// posted comments and proposed text out of the review sidebar.
const css = readFileSync("styles.css", "utf8");

function ruleBody(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
	if (!match) throw new Error(`no rule for ${selector}`);
	return match[1];
}

test.each([".critic-message-text", ".critic-card-body"])(
	"%s text is selectable",
	(selector) => {
		expect(ruleBody(selector)).toMatch(/(^|[\s;])user-select:\s*text\s*;/);
	},
);
