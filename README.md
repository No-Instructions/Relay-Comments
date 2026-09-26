# Relay Comments

Comments and suggested edits for Obsidian notes, stored in the note itself.

Select text, add a comment, and discuss it in a review sidebar, the way you
would in Google Docs. Propose additions, deletions, and replacements that the
author accepts or rejects with one click. Relay Comments writes all of this
into the Markdown file as plain [CriticMarkup](#the-format), so the review
needs no server and stays readable in any editor. Anything that syncs text
syncs the review too.

## Discuss a passage

Select text and add a comment with `Ctrl+Alt+M` (`Cmd+Opt+M` on macOS), the
margin button, or the right-click menu. Replies stack into a thread anchored
to the passage, and collaborators' comments land in your note as they write
them. Hover a commented passage to read its thread in place; from the preview
you can reply or open the full thread. Comments are Markdown, rendered by
Obsidian, so formatting, lists, code, links, and embeds all work.

![A comment arrives in a daily note, is read from the hover preview, and gets a reply](docs/comment-thread.gif)

## Suggest edits

Comments discuss the text. Suggestions change it. Mark additions
`{++like this++}`, deletions `{--like this--}`, and replacements
`{~~old~>new~~}`, then review them where they sit: hover a suggestion and
accept or reject it from the preview. To accept every suggestion and clear
every comment at once, run `Finalize for publish`.

![Hovering a suggested replacement shows Accept and Reject; accepting rewrites the text in place](docs/suggested-edits.gif)

## Review in the sidebar

Previews handle one passage at a time. The sidebar shows the whole note: every
comment, suggestion, and highlight in document order, with colored spines and
diff chips that tell you what each one is at a glance. Click a card to jump to
its place in the note. Resolve a thread and the markup leaves the note; the
text stays.

![Opening the review sidebar, jumping to a suggestion from its card, and resolving a thread](docs/review-sidebar.gif)

## Comment on canvases

On a canvas, comments become pins, as in Figma. Comment on a card from its
right-click menu, or click the card in comment mode, and the pin docks at the
card's corner. Click the empty board and a freestanding pin lands there. A pin
shows the author's initial and keeps its size at any zoom. When its card
moves, the pin moves with it. Click a pin to open its thread in a floating
panel, where you can reply or resolve it.

![A canvas card gets a comment from its right-click menu, then a freestanding pin lands between two cards](docs/canvas-comments.gif)

## Authorship and identity

Every comment names its author, and no account or other plugin is required
for that. A comment can carry a plain name such as `Bongo Cat`; without an
identity service, the plugin settings ask for your name and an optional
profile picture. If [Relay](https://relay.md) or Obsidian Sync is installed,
it can supply your identity instead. When both are, pick one in the settings.

The `identities` array in the plugin's `data.json` is a directory for
resolving other people's author IDs. The plugin never treats an entry there as
your own identity.

## Privacy and network access

Relay Comments has no account and sends no telemetry. It does not upload
notes anywhere. If you choose Relay or Obsidian Sync as your identity
provider, the plugin asks that service for identity records, and the
service's own network and privacy behavior applies. Obsidian loads
profile-picture URLs when it displays the avatars.

## Usage notes

- Live Preview and Reading mode render review marks and hide the raw
  delimiters. Source mode shows the plain text. The plugin never hides
  half-typed markup, so nothing disappears while you type.
- Sidebar cards have a Resolve action. Suggestions add Accept and Reject
  under the `⋯` menu.
- On a canvas, the add-comment shortcut starts click-to-place.

Search the command palette for "Relay Comments" to find the commands. They
cover opening and closing the sidebar, adding comments to notes and canvases,
showing the comment preview at the cursor, highlighting, marking additions,
deletions, and substitutions, accepting or rejecting the current mark or all
marks, and finalizing for publish. The ribbon icon toggles the sidebar.

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

A comment can also attach to Obsidian's native `==highlight==` syntax without
converting the highlight to CriticMarkup.

An authored comment stores a provider identity next to a portable display
name:

```
{==the passage==}{{authorId="service-user-id" author="Bongo Cat">>Can we ground this sooner?<<}}
```

The same comment markup attaches to an existing native highlight:

```markdown
==the passage=={{authorId="service-user-id" author="Bongo Cat">>Can we ground this sooner?<<}}
```

`authorId` is the opaque ID issued by the selected identity provider.
`author` is the display name, which still works when that provider is
unavailable. When only one value is known, the plugin stores it in `author`
and omits `authorId`. The plugin looks up avatars, colors, and other profile
details when it displays the note; it never writes them into the Markdown.

Any CriticMarkup-aware tool still reads the note. Plain-Markdown tools see
readable text with visible annotations.

## Installation

Install from the
[community plugin catalog](https://community.obsidian.md/plugins/relay-comments),
or from inside Obsidian:

1. Open Settings, then Community plugins, and select Browse.
2. Search for Relay Comments and select Install.
3. Select Enable.

## Development

```bash
npm install
npm run check   # typecheck src/
npm run build   # typecheck + produce main.js
```

Unit tests live in `tests/unit/`; `npm test` runs them on any checkout. See
[CONTRIBUTING](CONTRIBUTING.md).

## License

[MIT](LICENSE)
