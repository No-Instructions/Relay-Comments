import {
	collectExternalCommentComponents,
	groupExternalCommentComponents,
	scrollToExternalComment,
} from "../../../src/dom/comment-components";
import { externalCommentMutationMatters } from "../../../src/dom/comment-mutations";

class FakeElement {
	nodeType = 1;
	tagName = "DIV";
	parent: FakeElement | null = null;
	children: FakeElement[] = [];
	textContent = "";
	isConnected = true;
	scrollOptions: ScrollIntoViewOptions | null = null;
	contentDocument?: { body: FakeElement };

	constructor(
		private attributes: Record<string, string> = {},
		text = "",
	) {
		this.textContent = text;
	}

	append(...children: FakeElement[]): this {
		for (const child of children) {
			child.parent = this;
			this.children.push(child);
		}
		return this;
	}

	getAttribute(name: string): string | null {
		return this.attributes[name] ?? null;
	}
	get parentElement(): FakeElement | null { return this.parent; }
	setAttribute(name: string, value: string): void { this.attributes[name] = value; }
	removeAttribute(name: string): void { delete this.attributes[name]; }
	querySelector(selector: string): FakeElement | null {
		return this.querySelectorAll<FakeElement>(selector)[0] ?? null;
	}

	querySelectorAll<T>(selector: string): T[] {
		const found: FakeElement[] = [];
		const visit = (element: FakeElement): void => {
			for (const child of element.children) {
				if (child.matches(selector)) found.push(child);
				visit(child);
			}
		};
		visit(this);
		return found as T[];
	}

	closest(selector: string): FakeElement | null {
		let current: FakeElement | null = this;
		while (current) {
			if (current.matches(selector)) return current;
			current = current.parent;
		}
		return null;
	}

	scrollIntoView(options?: boolean | ScrollIntoViewOptions): void {
		this.scrollOptions =
			typeof options === "object" && options !== null ? options : {};
	}

	matches(selector: string): boolean {
		if (selector.includes(",")) return selector.split(",").some(part => this.matches(part.trim()));
		if (selector === '[data-criticmarkup-comment="v1"][data-criticmarkup-target]') {
			return this.attributes["data-criticmarkup-comment"] === "v1" && "data-criticmarkup-target" in this.attributes;
		}
		if (selector === "iframe") return this.tagName === "IFRAME";
		if (selector === '[data-criticmarkup-comment="v1"]') {
			return this.attributes["data-criticmarkup-comment"] === "v1";
		}
		if (selector === "[data-criticmarkup-body]") {
			return "data-criticmarkup-body" in this.attributes;
		}
		if (selector === "[id]") return "id" in this.attributes;
		return false;
	}
}

function element(
	attributes: Record<string, string> = {},
	text = "",
): FakeElement {
	return new FakeElement(attributes, text);
}

function asHtml(value: FakeElement): HTMLElement {
	return value as unknown as HTMLElement;
}

describe("rendered CriticMarkup comment components", () => {
	test("collects metadata, body text, and a target scoped to the leaf", () => {
		const target = element({ id: "line-42" });
		const body = element(
			{ "data-criticmarkup-body": "" },
			"  Could   this be simpler?  ",
		);
		const component = element({
			"data-criticmarkup-comment": "v1",
			"data-criticmarkup-author": " service-user-id ",
			"data-criticmarkup-status": "resolved",
			"data-criticmarkup-thread": "thread-17",
			"data-criticmarkup-key": "message-4",
			"data-criticmarkup-target": "line-42",
			"data-criticmarkup-label": "plugin.ts:42",
		}).append(body);
		const root = element().append(target, component);

		const comments = collectExternalCommentComponents(asHtml(root));

		expect(comments).toHaveLength(1);
		expect(comments[0]).toMatchObject({
			author: "service-user-id",
			status: "resolved",
			thread: "thread-17",
			key: "message-4",
			label: "plugin.ts:42",
			bodyText: "Could this be simpler?",
			snapshotKey: "key:message-4",
		});
		expect(comments[0].targetElement).toBe(asHtml(target));
	});

	test("ignores unsupported markers and bodies owned by nested comments", () => {
		const unsupported = element({
			"data-criticmarkup-comment": "v2",
		}).append(element({ "data-criticmarkup-body": "" }, "future"));
		const nested = element({
			"data-criticmarkup-comment": "v1",
		}).append(element({ "data-criticmarkup-body": "" }, "nested"));
		const outer = element({
			"data-criticmarkup-comment": "v1",
		}).append(nested);
		const root = element().append(unsupported, outer);

		const comments = collectExternalCommentComponents(asHtml(root));

		expect(comments.map((comment) => comment.bodyText)).toEqual(["nested"]);
	});

	test("groups threads while leaving unthreaded comments separate", () => {
		const makeComment = (
			text: string,
			attributes: Record<string, string> = {},
		): FakeElement =>
			element({
				"data-criticmarkup-comment": "v1",
				...attributes,
			}).append(element({ "data-criticmarkup-body": "" }, text));
		const root = element().append(
			makeComment("first", {
				"data-criticmarkup-thread": "thread-1",
				"data-criticmarkup-status": "resolved",
			}),
			makeComment("reply", {
				"data-criticmarkup-thread": "thread-1",
				"data-criticmarkup-status": "open",
				"data-criticmarkup-label": "line 7",
			}),
			makeComment("separate"),
		);

		const groups = groupExternalCommentComponents(
			collectExternalCommentComponents(asHtml(root)),
		);

		expect(groups).toHaveLength(2);
		expect(groups[0]).toMatchObject({
			snapshotKey: "thread:thread-1",
			label: "line 7",
			status: "open",
		});
		expect(groups[0].comments).toHaveLength(2);
		expect(groups[1].comments).toHaveLength(1);
	});

	test("collects components rendered inside same-origin Canvas frames", () => {
		const body = element().append(
			element({ "data-criticmarkup-comment": "v1" }).append(
				element({ "data-criticmarkup-body": "" }, "Embedded comment"),
			),
		);
		const frame = element();
		frame.tagName = "IFRAME";
		frame.contentDocument = { body };
		const root = element().append(frame);

		expect(
			collectExternalCommentComponents(asHtml(root)).map(
				(comment) => comment.bodyText,
			),
		).toEqual(["Embedded comment"]);
	});

	test("scrolls to the declared target and falls back only while connected", () => {
		const target = element({ id: "target" });
		const component = element({
			"data-criticmarkup-comment": "v1",
			"data-criticmarkup-target": "target",
		}).append(element({ "data-criticmarkup-body": "" }, "body"));
		const root = element().append(target, component);
		const [comment] = collectExternalCommentComponents(asHtml(root));

		expect(scrollToExternalComment(comment)).toBe(true);
		expect(target.scrollOptions).toEqual({
			behavior: "smooth",
			block: "center",
			inline: "nearest",
		});

		target.isConnected = false;
		expect(scrollToExternalComment(comment)).toBe(true);
		expect(component.scrollOptions).not.toBeNull();

		component.isConnected = false;
		expect(scrollToExternalComment(comment)).toBe(false);
	});
});

describe("external comment mutation filtering", () => {
	const record = (target: FakeElement, properties: Partial<MutationRecord> = {}): MutationRecord => ({
		type: "childList", target: target as unknown as Node,
		addedNodes: [], removedNodes: [], attributeName: null, oldValue: null,
		...properties,
	} as unknown as MutationRecord);
	const nodes = (...elements: FakeElement[]): NodeList => elements as unknown as NodeList;
	const component = (): FakeElement => element({"data-criticmarkup-comment": "v1"})
		.append(element({"data-criticmarkup-body": ""}, "Please review"));

	test("ignores terminal row replacements and text edits, even beside comments", () => {
		const terminal = element().append(element({}, "output"));
		const root = element().append(component(), terminal);
		expect(externalCommentMutationMatters(asHtml(root), record(terminal, {
			addedNodes: nodes(element({}, "next output")), removedNodes: nodes(terminal.children[0]),
		}))).toBe(false);
		expect(externalCommentMutationMatters(asHtml(root), record(terminal, {
			type: "characterData", target: {nodeType: 3, parentElement: terminal} as unknown as Node,
		}))).toBe(false);
	});

	test.each(["addedNodes", "removedNodes"] as const)("detects a provider index in %s, including its first or last comment", (key) => {
		const root = element();
		const index = element().append(component());
		expect(externalCommentMutationMatters(asHtml(root), record(root, {[key]: nodes(index)}))).toBe(true);
	});

	test("detects body text edits and body replacement/removal", () => {
		const comment = component();
		const body = comment.children[0];
		const root = element().append(comment);
		expect(externalCommentMutationMatters(asHtml(root), record(body, {
			type: "characterData", target: {nodeType: 3, parentElement: body} as unknown as Node,
		}))).toBe(true);
		expect(externalCommentMutationMatters(asHtml(root), record(comment, {removedNodes: nodes(body)}))).toBe(true);
		body.removeAttribute("data-criticmarkup-body");
		expect(externalCommentMutationMatters(asHtml(root), record(body, {
			type: "attributes", attributeName: "data-criticmarkup-body", oldValue: "",
		}))).toBe(true);
	});

	test.each(["author", "status", "thread", "key", "target", "label"])("detects %s changes from Relay Diffs", (field) => {
		const comment = component();
		const name = `data-criticmarkup-${field}`;
		comment.setAttribute(name, "changed");
		const root = element().append(comment);
		expect(externalCommentMutationMatters(asHtml(root), record(comment, {
			type: "attributes", attributeName: name, oldValue: "previous",
		}))).toBe(true);
		expect(externalCommentMutationMatters(asHtml(root), record(comment, {
			type: "attributes", attributeName: name, oldValue: "changed",
		}))).toBe(false);
	});

	test("detects marker removal or unsupported version, and ignores other metadata", () => {
		const comment = element({"data-criticmarkup-comment": "v2"});
		const root = element().append(comment);
		const changed = record(comment, {type: "attributes", attributeName: "data-criticmarkup-comment", oldValue: "v1"});
		expect(externalCommentMutationMatters(asHtml(root), changed)).toBe(true);
		comment.removeAttribute("data-criticmarkup-comment");
		expect(externalCommentMutationMatters(asHtml(root), changed)).toBe(true);
		expect(externalCommentMutationMatters(asHtml(root), record(comment, {
			type: "attributes", attributeName: "data-criticmarkup-author", oldValue: "old",
		}))).toBe(false);
	});

	test("tracks referenced target insertion, removal, replacement and ID changes", () => {
		const comment = component();
		comment.setAttribute("data-criticmarkup-target", "line-42");
		const root = element().append(comment);
		const target = element({id: "line-42"});
		for (const key of ["addedNodes", "removedNodes"]) {
			expect(externalCommentMutationMatters(asHtml(root), record(root, {[key]: nodes(target)}))).toBe(true);
		}
		target.setAttribute("id", "line-43");
		expect(externalCommentMutationMatters(asHtml(root), record(target, {type: "attributes", attributeName: "id", oldValue: "line-42"}))).toBe(true);
		expect(externalCommentMutationMatters(asHtml(root), record(target, {type: "attributes", attributeName: "id", oldValue: "unrelated"}))).toBe(false);
		expect(externalCommentMutationMatters(asHtml(root), record(root, {addedNodes: nodes(target)}))).toBe(false);
	});

	test("preserves collection of newly inserted Canvas frames", () => {
		const root = element();
		const frame = element(); frame.tagName = "IFRAME";
		expect(externalCommentMutationMatters(asHtml(root), record(root, {addedNodes: nodes(frame)}))).toBe(true);
	});
});
