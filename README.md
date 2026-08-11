# Relay Comments

Comments and suggested edits for Obsidian notes — stored in the note itself.

Select text, add a comment, and discuss it in a review sidebar, Google
Docs-style. Propose additions, deletions, and replacements that the author
can accept or reject with one action. Everything is written into the
Markdown file as plain [CriticMarkup](#the-format), so review state
survives without a server, syncs with anything that syncs text, and stays
readable in any editor.

## Discuss a passage

Select text and comment — `Ctrl+Alt+M` (`Cmd+Opt+M` on macOS), the margin
button, or the right-click menu. Replies stack into a thread anchored to
the passage, and collaborators' comments land in your note as they write
them. Hover any commented passage to read the thread in place; the
preview's links reply or open the full thread.

![A comment arrives in a daily note, is read from the hover preview, and gets a reply](docs/comment-thread.gif)

## Suggest edits

Mark additions `{++like this++}`, deletions `{--like this--}`, and
replacements `{~~old~>new~~}`. Review them where they sit: hover a
suggestion and **Accept** or **Reject** it from the preview — or sweep
the whole note at once with `Finalize for publish`.

![Hovering a suggested replacement shows Accept and Reject; accepting rewrites the text in place](docs/suggested-edits.gif)

## Review in the sidebar

Every comment, suggestion, and highlight in the note, in document order,
with colored spines and diff chips so you can scan what each one is.
Click a card to jump to its place in the note; resolve a thread with one
click — the markup leaves the note, the text stays.

![Opening the review sidebar, jumping to a suggestion from its card, and resolving a thread](docs/review-sidebar.gif)

## Comment on canvases

Figma-style pins on any canvas: comment on a card — from its right-click
menu or by clicking it in comment mode — and the pin docks at the card's
corner; click the empty board to drop a freestanding pin right there.
Pins carry the author's initial, hold their size at any zoom, ride their
card when it moves, and open a floating thread to read, reply, and
resolve.

![A canvas card gets a comment from its right-click menu, then a freestanding pin lands between two cards](docs/canvas-comments.gif)

## Authorship and identity

No account or plugin dependency is required. Comments can use a plain
author name such as `Bongo Cat`; when no identity service is available,
Relay Comments settings ask for your name and an optional profile
picture. [Relay](https://relay.md) and Obsidian Sync can instead supply
your service identity. When both are available, choose one in Relay
Comments settings.

The `identities` array in the plugin's `data.json` is a directory for
resolving other people's author IDs. Those entries are never treated as
your own identity.

## Privacy and network access

Relay Comments has no account, telemetry, or direct note-upload service.
When you select Relay or Obsidian Sync as your identity provider, Relay
Comments asks that installed service for identity records; that service's
network and privacy behavior still applies. Profile-picture URLs are loaded
by Obsidian when their avatars are displayed.

## Usage notes

- Live Preview and Reading mode render review marks and hide the raw
  delimiters; Source mode shows the plain text. Half-typed markup is
  never hidden, so nothing silently disappears while you type.
- Sidebar cards carry **Resolve**; suggestions add **Accept** /
  **Reject** under the `⋯` menu.
- On a canvas, the add-comment shortcut starts click-to-place.

Commands (search "Relay Comments" in the command palette): open/close the
review sidebar, add comment, add comment to canvas (click to place), show
comment preview at cursor, highlight selection, mark selection as
addition/deletion/substitution, accept/reject current, accept/reject all,
and finalize for publish. The ribbon icon toggles the sidebar.

## The format

Notes stay portable because review state is plain text in the
[CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit) syntax:

| Mark | Syntax |
| --- | --- |
| Addition | `{++inserted text++}` |
| Deletion | `{--removed text--}` |
| Replacement | `{~~old~>new~~}` |
| Highlight | `{==marked text==}` |
| Comment | `{>>comment text<<}` |

Authored comments use the established `author` metadata field:

```
{==the passage==}{{author="Bongo Cat">>Can we ground this sooner?<<}}
```

`author` may be a display name or an ID understood by the selected
identity provider or the local identity directory. When it is an ID,
names, avatars, and colors are resolved when the note is displayed and
are not duplicated into its Markdown.

Any CriticMarkup-aware tool still reads the note; plain-Markdown tools see
readable text with visible annotations.

## Installation

Relay Comments is not yet in the community plugin catalog. To install
manually:

1. Build or download `main.js`, `manifest.json`, and `styles.css`.
2. Copy them to `<vault>/.obsidian/plugins/relay-comments/`.
3. Enable **Relay Comments** in Settings → Community plugins.

## Development

```bash
npm install
npm run check   # typecheck src/
npm run build   # typecheck + produce main.js
```

Unit tests live in `tests/unit/` — `npm test` runs them on any checkout.
See [CONTRIBUTING](CONTRIBUTING.md).

## License

[MIT](LICENSE)
