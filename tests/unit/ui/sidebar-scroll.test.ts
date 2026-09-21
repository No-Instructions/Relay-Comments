import { describe, expect, it } from "@jest/globals";
import { sidebarScrollTopForRender } from "src/ui/sidebar-scroll";

describe("sidebar scroll restoration", () => {
	it("keeps the viewport steady while the same note rerenders", () => {
		expect(
			sidebarScrollTopForRender("review:one.md", "review:one.md", 420),
		).toBe(420);
	});

	it("starts a different note at the top", () => {
		expect(
			sidebarScrollTopForRender("review:one.md", "review:two.md", 420),
		).toBe(0);
	});

	it("does not carry scroll between editor and rendered-comment surfaces", () => {
		expect(
			sidebarScrollTopForRender(
				"review:one.md",
				"external:one.md",
				420,
			),
		).toBe(0);
	});

	it("starts the initial render at the top", () => {
		expect(sidebarScrollTopForRender(null, "review:one.md", 420)).toBe(0);
	});
});
