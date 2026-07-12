import { describe, expect, it } from "@jest/globals";
import { parseCommentLinks } from "src/critic/comment-links";

describe("parseCommentLinks", () => {
	it("returns plain text as a single segment", () => {
		expect(parseCommentLinks("just a note")).toEqual([
			{ kind: "text", text: "just a note" },
		]);
	});

	it("returns no segments for an empty body", () => {
		expect(parseCommentLinks("")).toEqual([]);
	});

	describe("wikilinks", () => {
		it("parses a bare wikilink", () => {
			expect(parseCommentLinks("see [[Meeting Notes]]")).toEqual([
				{ kind: "text", text: "see " },
				{ kind: "wikilink", target: "Meeting Notes", display: "Meeting Notes" },
			]);
		});

		it("splits target and alias on the first pipe", () => {
			expect(parseCommentLinks("[[Notes|the notes|really]]")).toEqual([
				{ kind: "wikilink", target: "Notes", display: "the notes|really" },
			]);
		});

		it("keeps headings and block refs in the target", () => {
			expect(parseCommentLinks("[[Notes#Agenda]] and [[Notes#^block]]")).toEqual([
				{ kind: "wikilink", target: "Notes#Agenda", display: "Notes#Agenda" },
				{ kind: "text", text: " and " },
				{ kind: "wikilink", target: "Notes#^block", display: "Notes#^block" },
			]);
		});

		it("trims whitespace around the target", () => {
			expect(parseCommentLinks("[[ Notes ]]")).toEqual([
				{ kind: "wikilink", target: "Notes", display: "Notes" },
			]);
		});

		it("falls back to the target when the alias is blank", () => {
			expect(parseCommentLinks("[[Notes|]]")).toEqual([
				{ kind: "wikilink", target: "Notes", display: "Notes" },
			]);
		});

		it("leaves an unterminated wikilink as text", () => {
			expect(parseCommentLinks("see [[Notes")).toEqual([
				{ kind: "text", text: "see [[Notes" },
			]);
		});

		it("leaves empty and blank wikilinks as text", () => {
			expect(parseCommentLinks("[[]] and [[  ]] and [[|alias]]")).toEqual([
				{ kind: "text", text: "[[]] and [[  ]] and [[|alias]]" },
			]);
		});

		it("does not span lines", () => {
			expect(parseCommentLinks("[[a\nb]]")).toEqual([
				{ kind: "text", text: "[[a\nb]]" },
			]);
		});

		it("recovers the inner link when openers nest", () => {
			expect(parseCommentLinks("[[a [[b]]")).toEqual([
				{ kind: "text", text: "[[a " },
				{ kind: "wikilink", target: "b", display: "b" },
			]);
		});

		it("parses adjacent wikilinks", () => {
			expect(parseCommentLinks("[[a]][[b]]")).toEqual([
				{ kind: "wikilink", target: "a", display: "a" },
				{ kind: "wikilink", target: "b", display: "b" },
			]);
		});

		it("reads a stray outer bracket as text around the real link", () => {
			expect(parseCommentLinks("[[[Alpha]]]")).toEqual([
				{ kind: "text", text: "[" },
				{ kind: "wikilink", target: "Alpha", display: "Alpha" },
				{ kind: "text", text: "]" },
			]);
		});

		it("rejects targets carrying a bracket", () => {
			expect(parseCommentLinks("[[a]b]]")).toEqual([
				{ kind: "text", text: "[[a]b]]" },
			]);
		});
	});

	describe("bare web links", () => {
		it("parses an http and an https URL", () => {
			expect(parseCommentLinks("http://a.io or https://b.io/path?q=1")).toEqual([
				{ kind: "weblink", href: "http://a.io", display: "http://a.io" },
				{ kind: "text", text: " or " },
				{
					kind: "weblink",
					href: "https://b.io/path?q=1",
					display: "https://b.io/path?q=1",
				},
			]);
		});

		it("keeps sentence punctuation out of the URL", () => {
			expect(parseCommentLinks("read https://a.io/doc.")).toEqual([
				{ kind: "text", text: "read " },
				{ kind: "weblink", href: "https://a.io/doc", display: "https://a.io/doc" },
				{ kind: "text", text: "." },
			]);
			expect(parseCommentLinks("really, https://a.io/doc, right?")).toEqual([
				{ kind: "text", text: "really, " },
				{ kind: "weblink", href: "https://a.io/doc", display: "https://a.io/doc" },
				{ kind: "text", text: ", right?" },
			]);
		});

		it("drops a wrapping paren but keeps a balanced one", () => {
			expect(parseCommentLinks("(see https://a.io/doc)")).toEqual([
				{ kind: "text", text: "(see " },
				{ kind: "weblink", href: "https://a.io/doc", display: "https://a.io/doc" },
				{ kind: "text", text: ")" },
			]);
			expect(
				parseCommentLinks("https://en.wikipedia.org/wiki/Foo_(bar)"),
			).toEqual([
				{
					kind: "weblink",
					href: "https://en.wikipedia.org/wiki/Foo_(bar)",
					display: "https://en.wikipedia.org/wiki/Foo_(bar)",
				},
			]);
		});

		it("unwraps angle brackets", () => {
			expect(parseCommentLinks("<https://a.io>")).toEqual([
				{ kind: "text", text: "<" },
				{ kind: "weblink", href: "https://a.io", display: "https://a.io" },
				{ kind: "text", text: ">" },
			]);
		});

		it("stops at whitespace and newlines", () => {
			expect(parseCommentLinks("https://a.io\nnext line")).toEqual([
				{ kind: "weblink", href: "https://a.io", display: "https://a.io" },
				{ kind: "text", text: "\nnext line" },
			]);
		});

		it("ignores schemeless and non-http schemes", () => {
			expect(parseCommentLinks("a.io and ftp://a.io stay text")).toEqual([
				{ kind: "text", text: "a.io and ftp://a.io stay text" },
			]);
		});

		it("matches the scheme case-insensitively", () => {
			expect(parseCommentLinks("HTTPS://A.IO")).toEqual([
				{ kind: "weblink", href: "HTTPS://A.IO", display: "HTTPS://A.IO" },
			]);
		});

		it("leaves a bare scheme as text", () => {
			expect(parseCommentLinks("see https://. ok")).toEqual([
				{ kind: "text", text: "see https://. ok" },
			]);
			expect(parseCommentLinks("copied from https://…")).toEqual([
				{ kind: "text", text: "copied from https://…" },
			]);
		});

		it("stops a URL at a glued wikilink", () => {
			expect(parseCommentLinks("see https://a.io[[Notes]] end")).toEqual([
				{ kind: "text", text: "see " },
				{ kind: "weblink", href: "https://a.io", display: "https://a.io" },
				{ kind: "wikilink", target: "Notes", display: "Notes" },
				{ kind: "text", text: " end" },
			]);
		});
	});

	describe("markdown links", () => {
		it("parses a labeled web link", () => {
			expect(parseCommentLinks("see [the docs](https://a.io/doc)")).toEqual([
				{ kind: "text", text: "see " },
				{ kind: "weblink", href: "https://a.io/doc", display: "the docs" },
			]);
		});

		it("keeps balanced parens inside the URL", () => {
			expect(
				parseCommentLinks("[foo](https://en.wikipedia.org/wiki/Foo_(bar))"),
			).toEqual([
				{
					kind: "weblink",
					href: "https://en.wikipedia.org/wiki/Foo_(bar)",
					display: "foo",
				},
			]);
		});

		it("requires an http(s) URL", () => {
			expect(parseCommentLinks("[note](Other Note.md)")).toEqual([
				{ kind: "text", text: "[note](Other Note.md)" },
			]);
		});

		it("still linkifies the URL when the label shape is off", () => {
			expect(parseCommentLinks("[](https://a.io)")).toEqual([
				{ kind: "text", text: "[](" },
				{ kind: "weblink", href: "https://a.io", display: "https://a.io" },
				{ kind: "text", text: ")" },
			]);
		});
	});

	describe("mixed content", () => {
		it("orders segments left to right across link kinds", () => {
			expect(
				parseCommentLinks("check [[Notes]] then https://a.io, thanks"),
			).toEqual([
				{ kind: "text", text: "check " },
				{ kind: "wikilink", target: "Notes", display: "Notes" },
				{ kind: "text", text: " then " },
				{ kind: "weblink", href: "https://a.io", display: "https://a.io" },
				{ kind: "text", text: ", thanks" },
			]);
		});

		it("prefers the wikilink when brackets collide", () => {
			expect(parseCommentLinks("[[a]](https://b.io)")).toEqual([
				{ kind: "wikilink", target: "a", display: "a" },
				{ kind: "text", text: "(" },
				{ kind: "weblink", href: "https://b.io", display: "https://b.io" },
				{ kind: "text", text: ")" },
			]);
		});

		it("does not linkify a URL inside a wikilink target", () => {
			expect(parseCommentLinks("[[https://a.io|mirror]]")).toEqual([
				{ kind: "wikilink", target: "https://a.io", display: "mirror" },
			]);
		});

		it("scales linearly across a link-heavy body", () => {
			const body = "[[a]] x [b](https://b.io) https://c.io ".repeat(2000);
			const segments = parseCommentLinks(body);
			expect(segments.length).toBe(2000 * 6);
			expect(segments[0]).toEqual({ kind: "wikilink", target: "a", display: "a" });
			expect(segments[segments.length - 2]).toEqual({
				kind: "weblink",
				href: "https://c.io",
				display: "https://c.io",
			});
		});

		it("round-trips every character of the body", () => {
			const body = "pre [[a|b]] mid https://c.io/(d), [e](https://f.io) post";
			const rebuilt = parseCommentLinks(body)
				.map((segment) => {
					if (segment.kind === "text") return segment.text;
					if (segment.kind === "wikilink")
						return `[[${segment.target}|${segment.display}]]`;
					return segment.display === segment.href
						? segment.href
						: `[${segment.display}](${segment.href})`;
				})
				.join("");
			expect(rebuilt).toBe(body);
		});
	});
});
