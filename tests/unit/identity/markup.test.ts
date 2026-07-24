import { describe, expect, it } from "@jest/globals";
import { formatAuthoredComment } from "src/identity/markup";

describe("formatAuthoredComment", () => {
	it("writes only the provider's service ID", () => {
		expect(formatAuthoredComment("Looks good", "123456")).toBe(
			'{{author="123456">>Looks good<<}}',
		);
	});

	it("supports a literal display name as the author value", () => {
		expect(formatAuthoredComment("Looks good", "Bongo Cat")).toBe(
			'{{author="Bongo Cat">>Looks good<<}}',
		);
	});

	it("uses plain CriticMarkup when no identity is available", () => {
		expect(formatAuthoredComment("Looks good")).toBe("{>>Looks good<<}");
	});

	it("does not alter or embed an unsafe service ID", () => {
		expect(formatAuthoredComment("Looks good", 'bad"id')).toBe(
			"{>>Looks good<<}",
		);
	});
});
