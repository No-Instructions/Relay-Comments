import { describe, expect, it } from "@jest/globals";
import {
	RELAY_COMMENTS_BUILD_ID,
	RELAY_COMMENTS_VERSION,
} from "src/buildInfo";

// esbuild injects the real values via defines; in every other environment
// (jest, tsc) the module must still import cleanly and fall back.
describe("buildInfo without esbuild defines", () => {
	it("falls back instead of throwing", () => {
		expect(RELAY_COMMENTS_VERSION).toBe("0.0.0");
		expect(RELAY_COMMENTS_BUILD_ID).toBe("dev");
	});
});
