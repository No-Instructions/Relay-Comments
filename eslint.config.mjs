import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
	globalIgnores([
		"node_modules",
		"coverage",
		"main.js",
		"package-lock.json",
		"tsconfig.json",
		"tsconfig.no-node.json",
		"versions.json",
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs", "manifest.json"],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		rules: {
			// Adding a comment uses the conventional Google Docs chord by design.
			"obsidianmd/commands/no-default-hotkeys": "off",
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					brands: [
						"Bongo Cat",
						"CodeMirror",
						"CriticMarkup",
						"Markdown",
						"Obsidian Sync",
						"Obsidian",
						"Relay Comments",
						"Relay",
					],
					enforceCamelCaseLower: true,
				},
			],
		},
	},
	{
		// Declarative settings require Obsidian 1.13; the plugin still supports 1.7.2.
		files: ["src/settings.ts"],
		rules: {
			"@typescript-eslint/no-deprecated": "off",
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
		},
	},
);
