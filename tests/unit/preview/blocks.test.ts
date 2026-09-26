import { describe, expect, it } from "@jest/globals";
import { parseCriticMarkup } from "src/critic/parse";
import {
	marksIntact,
	matchRenderedAnchor,
	repairMangledMarks,
	runsTouching,
	type RepairableElement,
	type RepairableNode,
} from "src/preview/blocks";

// A minimal DOM with just enough querySelectorAll for the mangled-mark selector.
class FakeText implements RepairableNode {
	nodeType = 3;
	parent: FakeElement | null = null;
	constructor(public nodeValue: string) {}
	get textContent(): string {
		return this.nodeValue;
	}
	get previousSibling(): RepairableNode | null {
		return this.parent?.siblingOf(this, -1) ?? null;
	}
	get nextSibling(): RepairableNode | null {
		return this.parent?.siblingOf(this, 1) ?? null;
	}
	remove(): void {
		this.parent?.removeChild(this);
	}
}

class FakeElement implements RepairableElement {
	nodeType = 1;
	nodeValue = null;
	parent: FakeElement | null = null;
	children: Array<FakeElement | FakeText> = [];
	constructor(
		public tagName: string,
		public className = "",
	) {}
	append(...nodes: Array<FakeElement | FakeText>): this {
		for (const node of nodes) {
			node.parent = this;
			this.children.push(node);
		}
		return this;
	}
	get textContent(): string {
		return this.children.map((child) => child.textContent ?? "").join("");
	}
	get previousSibling(): RepairableNode | null {
		return this.parent?.siblingOf(this, -1) ?? null;
	}
	get nextSibling(): RepairableNode | null {
		return this.parent?.siblingOf(this, 1) ?? null;
	}
	siblingOf(node: FakeElement | FakeText, step: number): RepairableNode | null {
		const index = this.children.indexOf(node);
		return index < 0 ? null : (this.children[index + step] ?? null);
	}
	removeChild(node: FakeElement | FakeText): void {
		this.children = this.children.filter((child) => child !== node);
		node.parent = null;
	}
	remove(): void {
		this.parent?.removeChild(this);
	}
	querySelectorAll(selector: string): FakeElement[] {
		expect(selector).toBe(
			"mark:not(.critic-preview-highlight), del:not(.critic-preview-deletion)",
		);
		const found: FakeElement[] = [];
		const visit = (element: FakeElement): void => {
			for (const child of element.children) {
				if (!(child instanceof FakeElement)) continue;
				const tag = child.tagName.toLowerCase();
				if (
					(tag === "mark" && !child.className.includes("critic-preview-highlight")) ||
					(tag === "del" && !child.className.includes("critic-preview-deletion"))
				) {
					found.push(child);
				}
				visit(child);
			}
		};
		visit(this);
		return found;
	}
}

const text = (value: string) => new FakeText(value);
const el = (tag: string, cls = "") => new FakeElement(tag, cls);

describe("repairMangledMarks", () => {
	it("turns a brace-wrapped native highlight back into a CriticMarkup anchor", () => {
		const cell = el("div").append(
			text("relay {"),
			el("mark").append(text("table cell")),
			text("}{>>cell comment<<} here"),
		);
		expect(repairMangledMarks(cell)).toBe(1);
		expect(cell.children).toHaveLength(1);
		expect(cell.textContent).toBe("relay {==table cell==}{>>cell comment<<} here");
	});

	it("turns brace-wrapped strikethrough back into a substitution", () => {
		const cell = el("div").append(
			text("{"),
			el("del").append(text("old~>new")),
			text("} in a cell"),
		);
		repairMangledMarks(cell);
		expect(cell.textContent).toBe("{~~old~>new~~} in a cell");
	});

	it("leaves highlights and strikethrough without braces alone", () => {
		const cell = el("div").append(
			text("plain "),
			el("mark").append(text("native highlight")),
			text(" and "),
			el("del").append(text("struck")),
			text(" text"),
		);
		expect(repairMangledMarks(cell)).toBe(0);
		expect(cell.children).toHaveLength(5);
	});

	it("keeps the plugin's own rendered marks", () => {
		const cell = el("div").append(
			text("{"),
			el("mark", "critic-preview-highlight").append(text("anchor")),
			text("}"),
		);
		expect(repairMangledMarks(cell)).toBe(0);
	});

	it("repairs inside nested inline formatting", () => {
		const strong = el("strong").append(
			text("bold {"),
			el("mark").append(text("anchor")),
			text("} text"),
		);
		const cell = el("div").append(text("before "), strong, text(" after"));
		repairMangledMarks(cell);
		expect(strong.textContent).toBe("bold {==anchor==} text");
		expect(cell.textContent).toBe("before bold {==anchor==} text after");
	});
});

describe("marksIntact", () => {
	const source = "Plain {==anchor==}{>>note<<} and {++added++} here.";
	const marks = parseCriticMarkup(source);

	it("is true when every mark sits whole inside one text node", () => {
		expect(marksIntact(["Plain {==anchor==}{>>note<<} and ", "{++added++} here."], marks)).toBe(true);
	});

	it("is false when Obsidian split a comment body across elements", () => {
		expect(marksIntact(["Plain {==anchor==}{>>see ", "<<} and {++added++} here."], marks)).toBe(false);
	});

	it("never treats a mark spanning lines as intact", () => {
		const multi = parseCriticMarkup("Anchor{>>first\n\nsecond<<}");
		expect(marksIntact(["Anchor{>>first\n\nsecond<<}"], multi)).toBe(false);
	});
});

describe("matchRenderedAnchor", () => {
	const source = [
		"| relay | {==table cell==}{>>cell comment<<} here |",
		"> Ship {==callout text==}{{author=\"Matt\">>for how long?<<}} today.",
		"Plain word{>>on the word<<} and again word{>>second<<} end.",
	].join("\n");
	const marks = parseCriticMarkup(source);
	const runs = runsTouching(source, marks, 0, source.length);

	it("resolves a highlight anchor to the highlight mark's range", () => {
		const match = matchRenderedAnchor(source, runs, marks, "table cell", null);
		const mark = marks.find((candidate) => candidate.raw === "{==table cell==}");
		expect(match).toEqual({ from: mark?.from, to: mark?.to });
	});

	it("resolves a metadata comment's highlight the same way", () => {
		const match = matchRenderedAnchor(source, runs, marks, "callout text", null);
		const mark = marks.find((candidate) => candidate.raw === "{==callout text==}");
		expect(match).toEqual({ from: mark?.from, to: mark?.to });
	});

	it("resolves a word-anchored comment by its word and title", () => {
		const match = matchRenderedAnchor(source, runs, marks, "word", "second");
		const mark = marks.find((candidate) => candidate.raw === "{>>second<<}");
		expect(match).toEqual({ from: mark?.from, to: mark?.to });
	});

	it("declines when the visible text alone is ambiguous", () => {
		expect(matchRenderedAnchor(source, runs, marks, "word", null)).toBeNull();
		expect(matchRenderedAnchor(source, runs, marks, "missing", null)).toBeNull();
	});
});
