import {
	collectExternalCommentComponents,
	groupExternalCommentComponents,
	scrollToExternalComment,
} from "../../../src/dom/comment-components";

class FakeElement {
	parent: FakeElement | null = null;
	children: FakeElement[] = [];
	textContent = "";
	isConnected = true;
	scrollOptions: ScrollIntoViewOptions | null = null;

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

	private matches(selector: string): boolean {
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
