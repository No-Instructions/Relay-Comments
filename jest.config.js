/** @type {import('ts-jest').JestConfigWithTsJest} */

module.exports = {
	testEnvironment: "node",
	roots: ["<rootDir>/tests/unit"],
	moduleNameMapper: {
		"^src/(.*)$": "<rootDir>/src/$1",
	},
	testPathIgnorePatterns: [
		"/node_modules/",
		"/.claude/",
		"/wiki/",
	],
	transform: {
		"^.+\\.ts$": [
			"ts-jest",
			{
				tsconfig: "tsconfig.test.json",
			},
		],
	},
};
