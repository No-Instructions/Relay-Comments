# Relay Comments - Phase 0 Spec

## Status

Draft for discussion. This project is an Obsidian community plugin named Relay Comments that adds CriticMarkup authoring, rendering, and review UI to Markdown notes. It is designed to work as a standalone comments and suggestions plugin and to gain collaboration-aware features when the Relay plugin is installed.

## Goals

1. Add first-class CriticMarkup support to Obsidian's CodeMirror 6 editor.
2. Keep the Markdown file as the standalone source of truth when Relay is absent. Suggestions, deletions, comments, and highlights are stored as plain CriticMarkup text in non-Relay mode.
3. Hide raw CriticMarkup delimiters in Obsidian Live Preview and Reading mode. Raw CriticMarkup is visible only in Obsidian Source mode.
4. Provide review commands for creating, accepting, rejecting, and navigating CriticMarkup marks.
5. Integrate with Relay through a small, stable TypeScript API so this plugin can show who created comments and suggestions without depending on Relay internals.
6. Degrade cleanly when Relay is missing, disabled, logged out, or the file is outside a shared folder.

## Non-Goals

1. Do not replace Relay's merge or conflict-resolution model.
2. Do not store comments in a separate non-Relay database as the primary source of truth.
3. Do not require Relay for local CriticMarkup editing.
4. Do not implement a full Markdown parser in this plugin unless Obsidian's rendering hooks prove insufficient.
5. Keep authored markup minimal: use the established `author` field and do not add parallel identity properties.

## References

- CriticMarkup toolkit and syntax: <https://github.com/CriticMarkup/CriticMarkup-toolkit>
- Obsidian Track Changes reference implementation, MIT licensed: <https://github.com/philphilphil/obsidian-track-changes>
- CodeMirror 6 decorations: <https://codemirror.net/examples/decoration/>
- CodeMirror 6 reference, decorations and match decorators: <https://codemirror.net/docs/ref/>
- Obsidian local API types currently expose `registerEditorExtension` and `registerMarkdownPostProcessor` in `node_modules/obsidian/obsidian.d.ts`.
- Relay patterns reviewed locally:
  - `~/stash/relay/src/LiveViews.ts`
  - `~/stash/relay/src/editorContext.ts`
  - `~/stash/relay/src/y-codemirror.next/UserAttributionPlugin.ts`
  - `~/stash/relay/src/markdownView/InvalidLinkExtension.ts`
  - `~/stash/relay/src/AwarenessViewPlugin.ts`

## CriticMarkup Syntax Scope

The parser must recognize the five standard mark types:

| Type | Syntax | Meaning |
| --- | --- | --- |
| Addition | `{++new text++}` | Suggested inserted text |
| Deletion | `{--old text--}` | Suggested removed text |
| Substitution | `{~~old text~>new text~~}` | Suggested replacement |
| Comment | `{>>comment<<}` | Plain text comment attached to nearby text |
| Highlight | `{==marked text==}` | Highlighted passage, often followed by a comment |

MVP caveats:

1. Support same-line marks for the MVP.
2. Treat multiline marks as unsupported in the MVP. If a mark contains a newline before its closing delimiter, avoid destructive transforms and do not offer accept/reject actions for that mark. Live Preview and Reading mode should still avoid showing raw delimiters when the parser can identify the malformed mark.
3. Avoid supporting nested CriticMarkup marks initially. Detect and surface invalid or ambiguous syntax rather than guessing.
4. Preserve Markdown compatibility expectations: CriticMarkup that wraps Markdown formatting should wrap complete Markdown constructs.

## Product Behavior

### Source Mode, Live Preview, and Reading Mode

Obsidian's own editor state is the only user-facing source visibility model:

1. Source mode shows the actual Markdown source, including CriticMarkup delimiters, for manual inspection and editing.
2. Live Preview replaces each complete CriticMarkup mark with rendered review UI. It must not reveal raw delimiters on cursor movement, selection, or double-click.
3. Reading mode hides raw CriticMarkup delimiters and renders the same review semantics as Live Preview.
4. There is no separate plugin mode switch. Suggestions are visible by default as review UI until the user accepts, rejects, resolves, or finalizes them.
5. All edits are normal CM6 transactions so Obsidian undo and Relay synchronization continue to work.

Review rendering policy:

1. Render additions as inserted text.
2. Render deletions as deleted text.
3. Render substitutions as old text plus new text.
4. Render comments as unobtrusive comment indicators or popovers.
5. Render highlights as highlighted text.

The plugin should provide:

1. A right-sidebar tab that is registered and selectable when Markdown is open, but not forced to the front on startup.
2. Commands and context menu items for creating comments and suggestions.
3. Accept, reject, resolve, and finalize actions that rewrite the Markdown source intentionally.

### Reading Mode

Reading mode must not expose raw CriticMarkup delimiters in normal use.

Implementation starts with `registerMarkdownPostProcessor`. Known risk: postprocessing rendered DOM is easy for simple text-node-contained marks, but harder for marks that span rendered Markdown elements such as emphasis or links. If this is not robust enough, the next design step is a more direct Markdown rendering hook or a controlled renderer patch.

### Commands

The plugin should register commands for:

1. Add insertion around selection.
2. Add deletion around selection.
3. Add substitution for selection, prompting for replacement text.
4. Add comment at cursor or around selection.
5. Highlight selection.
6. Accept current mark.
7. Reject current mark.
8. Accept all marks in file.
9. Reject all marks in file.
10. Open review sidebar.
11. Finalize for publish, equivalent to accepting all marks.
12. Add comment to the current selection, opening a sidebar draft card for text entry.

Accept/reject transformations:

| Type | Accept | Reject |
| --- | --- | --- |
| Addition | replace mark with added text | remove mark entirely |
| Deletion | remove mark entirely | replace mark with deleted text |
| Substitution | replace mark with new text | replace mark with old text |
| Comment | remove comment | remove comment |
| Highlight | remove delimiters, keep text | remove delimiters, keep text |

### Review Sidebar

The plugin should provide a right-sidebar review surface inspired by Google Docs comments and suggestions. The sidebar follows the active Markdown note and shows document-scoped review items derived from the current file's CriticMarkup marks.

Sidebar content:

1. Header with the active note name and counts for suggestions and comments.
2. A draft card for new comments when the user is adding a comment to the current selection.
3. A document-ordered list of review cards. Each card represents one CriticMarkup mark, or one highlight plus immediately following comment when they form a standard highlighted-comment pair.
4. Card body showing the proposed text change or comment text without raw delimiters.
5. Card metadata showing mark type, document location, and provider-resolved author when available.
6. Inline card actions:
   - accept suggestion
   - reject suggestion
   - reply by inserting an adjacent CriticMarkup comment
   - resolve comment/highlight
7. Empty state for notes with no CriticMarkup marks.
8. Unavailable state when no Markdown note is active.

Sidebar/editor synchronization:

1. Selecting a card centers the referenced text in the editor and vertically aligns the selected sidebar card with that anchor when space allows. For highlight-plus-comment threads, the target is the highlighted text, not the raw trailing comment.
2. Moving the cursor into a mark selects the matching sidebar card when the sidebar is open.
3. Accepting or rejecting from the sidebar performs the same source transformation as the command palette action.
4. The sidebar updates from CM6 document changes and reading-mode file changes without requiring a manual refresh.
5. The selected comment thread shows an inline reply textarea directly in the card. Unselected threads do not show a separate reply button.

Comment creation:

1. Selecting text should show an inline comment affordance near the selection.
2. Right-clicking selected editor text should include "Add comment".
3. Choosing Add comment opens the review sidebar, creates a draft card, and focuses its textarea.
4. Saving the draft writes `{==selected text==}{>>comment<<}` into the Markdown via a normal editor transaction.
5. Canceling the draft leaves the Markdown unchanged.

MVP constraint: the sidebar does not store independent comment threads or resolved states outside the Markdown document. A review card exists because a CriticMarkup mark exists. Resolving a suggestion removes or rewrites that mark.

## Architecture

### Package Layout

Proposed source layout:

```text
src/
  main.ts
  critic/
    parse.ts
    types.ts
    transform.ts
    render.ts
  editor/
    extension.ts
    decorations.ts
    widgets.ts
    commands.ts
  preview/
    postprocessor.ts
  identity/
    types.ts
    providers.ts
  ui/
    ReviewSidebarView.ts
    ReviewSidebar.svelte
    CommentPopover.svelte
  settings.ts
styles.css
manifest.json
package.json
```

### Parser Contract

The parser should be pure TypeScript with no Obsidian, CodeMirror, or Relay imports.

```ts
export type CriticMarkType =
  | "addition"
  | "deletion"
  | "substitution"
  | "comment"
  | "highlight";

export interface CriticMark {
  id: string;
  type: CriticMarkType;
  from: number;
  to: number;
  raw: string;
  contentFrom: number;
  contentTo: number;
  ranges: {
    opening?: [number, number];
    closing?: [number, number];
    oldText?: [number, number];
    newText?: [number, number];
    separator?: [number, number];
    commentText?: [number, number];
  };
  valid: boolean;
  error?: string;
}
```

`id` should be deterministic but ephemeral, for example a hash of type, range, and raw text. The MVP should not persist per-mark state outside the document.

### CM6 Rendering

The editor extension should use:

1. A `ViewPlugin` that reparses affected visible content on document changes.
2. `Decoration.mark` for visible semantic styling.
3. `Decoration.replace` for hidden delimiters and optional inline widgets.
4. `WidgetType` for comment badges, author chips, and action controls.
5. A state field or plugin-local state for settings that need dynamic updates.

Performance target: parsing and decoration updates should remain responsive on long notes. Start with full-document parsing for simplicity, then move to viewport-aware parsing or incremental indexing if measurements require it.

### Reading-Mode Rendering

The preview renderer should share the parser and rendering policy with the editor. It should skip:

1. Code blocks.
2. Inline code.
3. Math blocks and inline math.
4. HTML blocks where DOM rewriting would be unsafe.

For unsupported marks, the renderer should avoid destructive DOM mutations and leave source text visible rather than corrupting the rendered note.

## Canvas Comments (experimental)

Canvas comments are Figma-style pins: one pin per thread, placed on a
node or floating at a canvas position. The pin renders at constant
screen size regardless of zoom; clicking it opens a floating thread
card — same card shell, avatars, and composer as the review sidebar.
Adding: "Add comment" in the canvas node menu or the canvas background
right-click menu, or the "Add comment to canvas (click to place)"
command — same default chord as the editor's add-comment
(Ctrl/Cmd+Alt+M), crosshair cursor, Escape cancels. A comment on a node
always anchors at the node's top-right corner (`dx = width`, `dy = 0`),
independent of where the click landed; in click-to-place mode a click
over a node attaches to that node, a click on an existing pin or open
thread card exits the mode and lets that pin or card handle the click,
and only a click on empty canvas creates a freestanding carrier pin at
the click point. A node pin hangs from its top edge at `dx`/`dy` and
threads sharing an anchor stack downward at constant screen spacing so
no pin hides another; a freestanding pin is tip-anchored, its teardrop
tip on the clicked canvas point. The thread card opens top-aligned with
its pin.

### Storage format

Threads live on the canvas node they belong to, in a `relayComments`
field (verified to survive Obsidian's canvas save cycle; Relay stores
whole node objects in its CRDT, so the field syncs unchanged):

```json
{
  "id": "node1", "type": "text", "x": 0, "y": 0, "width": 320, "height": 120,
  "relayComments": [
    {
      "id": "cc-…",
      "dx": 320, "dy": 0,
      "resolved": false,
      "comments": [
        { "author": "Daniel", "authorId": "…", "date": "2026-07-06T…Z", "text": "…" }
      ]
    }
  ]
}
```

`dx`/`dy` position the pin relative to the node's top-left, in canvas
units, so pins ride node moves. Freestanding pins use an invisible
carrier node — `type: "text"`, empty text, zero width and height,
marked `relayCommentCarrier: true` — which is deleted when its last
thread is removed. Unknown node *types* must never be used for storage:
Obsidian deletes them on the next save.

### Rendering invariant

Pins and the open thread card are screen-space UI, not canvas content:
they live on an overlay above the zoomed `.canvas` layer (the same
approach as Obsidian's own node toolbar in `.canvas-menu-container`)
and never scale — there is no counter-scaling anywhere. Node elements
must not host them: Obsidian destroys and rebuilds node elements freely
(level-of-detail swaps mid-zoom), and anything inside the zoom
transform visibly scales during eased gestures because `tZoom` snaps to
the gesture target while the transform is still easing. Positions are
recomputed from the canvas element's rendered rect and node positions —
Obsidian writes those styles every animation frame of a pan, zoom, or
drag, and a style-attribute mutation observer (canvas subtree)
repositions the overlay before the following paint, so pins track with
zero lag and pixel-exact gaps mid-ease (verified frame-by-frame). Any
rendering that re-derives positions only from a timer or rAF loop lags
gestures and must not come back. The thread card flips to the pin's
left when the canvas pane's right edge (not the window's — panes clip)
would cut it off; the side is decided once per open and sticky.

Known gap: pins are not draggable yet, so a pin placed over node
content stays there until the thread is deleted and recreated. Pin
dragging (updating `dx`/`dy`, or `x`/`y` on a carrier) is the planned
fix.

## Relay Integration

### Dependency Model

Relay is optional. Relay Comments should discover Relay at runtime through Obsidian's plugin registry, not by importing Relay source.

Relay uses plugin id `system3-relay`. Consumers should use `plugin.api` instead of internal objects such as `_liveViews`, `sharedFolders`, `metadataBridge`, or raw Yjs documents.

### Identity Providers

Relay Comments owns review markup and consumes identity through a small
provider interface. Service providers answer two questions: who is the
current user, and whether a stored `author` value identifies a known
identity. Resolver-only directories can answer the latter without
claiming that one of their entries is the current user.
Range attribution is an optional enhancement, not part of the core
authorship model.

```ts
export interface Identity {
  id: string;
  name: string;
  picture?: string;
  color?: string;
  colorLight?: string;
}

export interface IdentityResolver {
  readonly id: "relay" | "obsidian-sync" | "configured";
  readonly name: string;

  isAvailable(): boolean;
  resolveUser(id: string, path: string): Promise<Identity | null>;
}

export interface IdentityProvider extends IdentityResolver {
  readonly id: "relay" | "obsidian-sync";

  getCurrentUser(path: string): Promise<Identity | null>;

  getAuthorForRange?(
    path: string,
    from: number,
    to: number,
  ): Promise<Identity | null>;
}
```

The initial current-user providers are:

1. Relay, through the public `plugin.api.identity` contract below.
2. Obsidian Sync, through an isolated adapter around the private Sync
   `userId` and `getUsernames()` surfaces.

Configured identities in Relay Comments' `data.json` form a resolver
directory for other people. They never supply the current user.

Relay Comments must not read Relay internals such as `_liveViews`, Yjs
maps, auth stores, `sharedFolders`, or `RelayManager.users` directly.
The Obsidian Sync adapter is explicitly best-effort because Obsidian
does not expose a supported public Sync identity API.

### Proposed Relay Public API

Relay exposes a stable object on its plugin instance:

```ts
export interface RelayPublicApiV1 {
  version: 1;
  identity: RelayIdentityApi;
}

export interface RelayIdentity {
  id: string;
  name: string;
  picture?: string;
  color?: string;
  colorLight?: string;
}

export interface RelayIdentityApi {
  getCurrentUser(path: string): Promise<RelayIdentity | null>;
  resolveUser(id: string, path: string): Promise<RelayIdentity | null>;

  getAuthorForRange?(
    path: string,
    from: number,
    to: number,
  ): Promise<RelayIdentity | null>;
}
```

Relay should announce API availability with a workspace event after load and after reload:

```ts
app.workspace.trigger("system3-relay:api-ready:v1", relayApi);
```

Relay Comments should also poll the plugin registry on load because plugin load order is not guaranteed:

```ts
const relay = app.plugins.plugins["system3-relay"] as
  | { api?: RelayPublicApiV1 }
  | undefined;
```

The API must not expose auth tokens. Email is not part of the contract.
Relay returns `null` for paths outside Relay shared folders.

### Provider Selection

When both service providers are available, settings show an identity
provider selector containing Relay and Obsidian Sync. There is no
automatic option. The selected service supplies the current user's ID
and is tried first when resolving stored author IDs. When only one
service is available, Relay Comments uses it without showing a selector.

When no service provider is available, settings show fields for the
current user's name and optional profile-picture URL. The name itself is
written to `author`; Relay Comments does not generate an ID for it.

If Relay is installed without the supported public identity API,
settings explain that Relay must be updated and keep the local profile
fields available.

Configured identities use the same `Identity` schema:

```json
{
  "identityProvider": null,
  "authorName": "Bongo Cat",
  "authorPicture": "https://example.com/bongo-cat.png",
  "identities": [
    {
      "id": "architecture-reviewer",
      "name": "Architecture reviewer",
      "color": "#7c3aed",
      "colorLight": "#7c3aed33"
    }
  ]
}
```

These values live with the plugin's other settings in `data.json`.
`authorName` and `authorPicture` describe the local user. Every entry in
`identities` describes another author whose stored ID should be expanded.
Different roles or models are separate directory entries; the schema
does not need role, model, or protocol-specific fields.

### Optional Relay CRDT Review Store

Relay-backed review storage is an optional capability for shared files. It is disabled when Relay is missing, logged out, or the current file is outside a shared folder. Standalone mode continues to use plain CriticMarkup in Markdown.

The preferred model is a sidecar CRDT structure inside the same Relay document, not hidden CriticMarkup text inside the editor buffer:

```ts
interface RelayReviewThread {
  id: string;
  kind: "comment" | "highlight" | "addition" | "deletion" | "substitution";
  anchor: {
    start: unknown; // Y.RelativePosition JSON
    end: unknown;   // Y.RelativePosition JSON
  };
  status: "open" | "resolved";
  createdBy: string;
  createdAt: string;
  messages: RelayReviewMessage[];
  suggestion?: {
    before?: string;
    after?: string;
  };
}

interface RelayReviewMessage {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
}
```

Relay should own all mutation methods for this store. Relay Comments should not receive or mutate the raw `Y.Doc`. A future API should expose operations such as `createThread`, `reply`, `editMessage`, `resolveThread`, and `observeThreads`.

Do not use Y.Text formatting attributes as the primary comment model. They are useful for inline marks, but comments need message chains, status, authors, timestamps, and suggestion metadata. A sidecar `Y.Map`/`Y.Array` anchored with `Y.RelativePosition` keeps document text clean while still moving anchors with collaborative text edits.

Open policy questions for the CRDT store:

1. What happens when the entire anchor text is deleted: collapse to an orphaned thread, auto-resolve, or keep a tombstone?
2. How should Relay export/import sidecar review data for users who need portable plain Markdown?
3. Should accepting a suggestion apply a normal editor text transaction and then resolve the sidecar thread, or should Relay expose one atomic command?
4. How should review operations participate in Relay undo and conflict diagnostics?

### Persisting Author Identity

Relay Comments writes exactly one identity property: `author`.

```text
{{author="Bongo Cat">>Comment text<<}}
```

The value may be a literal display name, as in the example, or an opaque
user ID issued by the active identity provider. Relay Comments first
offers the value to the selected provider and then to the configured
identity directory; if it is not resolved, it displays the value
literally. This preserves ordinary authored CriticMarkup such as
`author="Bongo Cat"` while allowing service IDs to expand into names,
avatars, and colors.

Relay Comments does not add a parallel `authorId`, provider name,
picture, color, email, date, or generated short ID to CriticMarkup.

Early and imported metadata such as `authorId` or `date` may still be
read for compatibility. A display-name `author` remains fully supported;
new comments simply avoid writing any additional identity properties.

Suggestion marks without an attached authored comment do not require an
author. A provider that implements `getAuthorForRange` may enhance their
display, but review behavior must never depend on range attribution.

### Identity-Aware UI

When identity data is available, the plugin should show:

1. Author chip/avatar on comment popovers and suggestion widgets.
2. Review sidebar filters by author, mark type, and file.
3. Tooltips showing author name and suggestion type.

When identity data is unavailable:

1. Keep all CriticMarkup features active.
2. Display the unresolved `author` ID when one is present.
3. Display comments using only their plain text content otherwise.

## Settings

Initial settings:

1. Identity provider when multiple services are available, or local
   name and profile picture when none are available.
2. Show inline comment controls.
3. Open the review sidebar when selecting comments.
4. Show comment previews on hover.

## Testing Strategy

Unit tests:

1. Parser fixtures for all five mark types.
2. Parser invalid syntax cases.
3. Accept/reject transformations.
4. Reading-mode render policy output.
5. Identity-provider selection and resolution.

Integration tests:

1. CM6 decorations hide delimiters outside selection.
2. Commands produce expected source text.
3. Reading mode hides raw delimiters.
4. Relay absent: plugin still works.
5. Relay present: author chips render from mocked public API.
6. Review sidebar lists marks for the active note and applies accept/reject actions.

Manual Obsidian checks:

1. Source mode, Live Preview, and Reading mode.
2. Undo/redo after accept/reject.
3. Files inside and outside Relay shared folders.
4. Review sidebar selection stays synchronized with the editor.
5. Mobile or constrained-width editor behavior if this becomes a release target.

## Open Questions

1. Should accept/reject all operate on the whole file immediately, or require confirmation when more than one mark is present?

## Phase Plan

### Phase 1 - Standalone CriticMarkup MVP

1. Scaffold Obsidian plugin.
2. Implement parser and transformations.
3. Add CM6 decorations and commands.
4. Add reading-mode postprocessor for simple, safe marks.
5. Add tests for parser, transforms, and rendering policy.

### Phase 2 - Relay Public API

1. Add `RelayPublicApiV1` to Relay.
2. Integrate this plugin with `plugin.api.identity`.
3. Add mocked Relay API tests.

### Phase 3 - Robust Review UX

1. Add full review sidebar.
2. Improve reading-mode rendering for marks crossing Markdown-rendered element boundaries.
3. Add navigation and batch actions.
4. Add edge-case tests for large files and concurrent edits.

### Phase 4 - Optional Relay CRDT Review Store

1. Add a Relay-owned sidecar review store anchored with Yjs relative positions.
2. Expose mutation and observation methods through `plugin.api`.
3. Add import/export between sidecar review data and plain CriticMarkup text.
4. Keep standalone/non-Relay notes on the Markdown-backed implementation.
