import { describe, expect, it } from "@jest/globals";

const { resolveBuildId } = require("../../scripts/build-id.cjs") as {
	resolveBuildId(
		manifestVersion: string,
		explicitBuildId?: string,
	): string;
};

describe("production build metadata", () => {
	it("uses the manifest version without environment-specific metadata", () => {
		expect(resolveBuildId("0.2.0")).toBe("0.2.0");
		expect(resolveBuildId("0.2.0", "   ")).toBe("0.2.0");
	});

	it("preserves explicit development build identifiers", () => {
		expect(resolveBuildId("0.2.0", " ae66e06-dirty ")).toBe(
			"ae66e06-dirty",
		);
	});
});
