import { describe, expect, it } from "@jest/globals";
import { formatAuthoredComment } from "src/identity/markup";

describe("formatAuthoredComment", () => {
	it("writes the service ID and the display name", () => {
		expect(formatAuthoredComment("Looks good", "123456", "Bongo Cat")).toBe(
			'{{authorId="123456" author="Bongo Cat">>Looks good<<}}',
		);
	});

	it("writes only the provider's service ID when no name is available", () => {
		expect(formatAuthoredComment("Looks good", "123456")).toBe(
			'{{author="123456">>Looks good<<}}',
		);
	});

	it("collapses a name identical to the service ID to one attribute", () => {
		expect(formatAuthoredComment("Looks good", "Bongo Cat", "Bongo Cat")).toBe(
			'{{author="Bongo Cat">>Looks good<<}}',
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

	it("keeps a safe name when only the service ID is unsafe", () => {
		expect(formatAuthoredComment("Looks good", 'bad"id', "Bongo Cat")).toBe(
			'{{author="Bongo Cat">>Looks good<<}}',
		);
	});

	it("drops an unsafe name and keeps the service ID", () => {
		expect(formatAuthoredComment("Looks good", "123456", 'bad"name')).toBe(
			'{{author="123456">>Looks good<<}}',
		);
	});
});
