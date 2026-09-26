# Relay Comments

Comments and suggested edits for Obsidian.

Relay Comments brings Google-Docs-style review to Obsidian. Comments and
suggested edits are written into the Markdown file as
[CriticMarkup](#the-format), and diff and sync with the note.

## Comments

Collaborators' comments appear in your note as they write them.

![A comment arrives in a daily note, is read from the hover preview, and gets a reply](docs/comment-thread.gif)

## Suggestions

Accept or reject in place, or accept everything at once when the review is
done.

![Hovering a suggested replacement shows Accept and Reject; accepting rewrites the text in place](docs/suggested-edits.gif)

## The sidebar

The sidebar lists the note's comments, suggestions, and highlights.
Resolving a thread removes its markup from the note.

![Opening the review sidebar, jumping to a suggestion from its card, and resolving a thread](docs/review-sidebar.gif)

## Identity

Relay Comments integrates with [Relay](https://relay.md) and Obsidian Sync
to provide user identity.

You can also add identities to the plugin's `data.json`. Each entry maps an ID to a
name, a picture, and a color. This allows an agent to self-register its identity:

```json
{
  "identities": [
    {
      "id": "mqvxlopr0ocsmgv",
      "name": "Shelly",
      "picture": "https://avatars.relay.md/?seed=as235jcgbe",
      "color": "#7c3aed"
    }
  ]
}
```

The data.json file is automatically reloaded on change.

Readers without a matching identity see the inline `author` field as the name.

## Agents

The [relay-comments skill](https://github.com/No-Instructions/relay-skills)
teaches agents to use CriticMarkup as well as monitor notes for comments to
respond inline.

## Canvas

Place pins to add spatial feedback about the canvas layout. Comment on nodes
or their contents.

![A canvas card gets a comment from its right-click menu, then a freestanding pin lands between two cards](docs/canvas-comments.gif)

## Privacy

Relay-comments does not make any network requests or have any client-side
telemetry.

## Format

Review state is [CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit):

| Mark | Syntax |
| --- | --- |
| Addition | `{++inserted text++}` |
| Deletion | `{--removed text--}` |
| Replacement | `{~~old~>new~~}` |
| Highlight | `{==marked text==}` |
| Comment | `{>>comment text<<}` |

Comments also attach to Obsidian's native `==highlight==` syntax.

The author is stored in the comment:

```
{==the passage==}{{authorId="j4n8b2x0q7m1zk5" author="Bongo Cat">>Can we ground this sooner?<<}}
```

## Installation

Install Relay Comments from the
[Obsidian community plugin catalog](https://community.obsidian.md/plugins/relay-comments).

## Development

```bash
npm install
npm run check   # typecheck src/
npm run build   # typecheck + produce main.js
```

Unit tests live in `tests/unit/`; `npm test` runs them. See
[CONTRIBUTING](CONTRIBUTING.md).

## License

[MIT](LICENSE)
