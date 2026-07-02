# CriticMarkup for Relay and Obsidian - Phase 0 Spec

## Status

Draft for discussion. This project is an Obsidian community plugin that adds CriticMarkup authoring, rendering, and review UI to Markdown notes. It is designed to work as a standalone CriticMarkup plugin and to gain collaboration-aware features when the Relay plugin is installed.

## Goals

1. Add first-class CriticMarkup support to Obsidian's CodeMirror 6 editor.
2. Keep the Markdown file as the source of truth. Suggestions, deletions, comments, and highlights are stored as plain CriticMarkup text.
3. Hide raw CriticMarkup delimiters in Obsidian's normal reading experience.
4. Provide review commands for creating, accepting, rejecting, and navigating CriticMarkup marks.
5. Integrate with Relay through a small, stable TypeScript API so this plugin can show who created comments and suggestions without depending on Relay internals.
6. Degrade cleanly when Relay is missing, disabled, logged out, or the file is outside a shared folder.

## Non-Goals

1. Do not replace Relay's merge or conflict-resolution model.
2. Do not store comments in a separate database as the primary source of truth.
3. Do not require Relay for local CriticMarkup editing.
4. Do not implement a full Markdown parser in this plugin unless Obsidian's rendering hooks prove insufficient.
5. Do not invent a CriticMarkup dialect for the MVP. Author identity is Relay-derived; any later optional metadata format must remain backwards-compatible plain text.

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
2. Treat multiline marks as unsupported in the MVP. If a mark contains a newline before its closing delimiter, leave the raw syntax visible and do not offer accept/reject actions for that mark.
3. Avoid supporting nested CriticMarkup marks initially. Detect and surface invalid or ambiguous syntax rather than guessing.
4. Preserve Markdown compatibility expectations: CriticMarkup that wraps Markdown formatting should wrap complete Markdown constructs.

## Product Behavior

### Source Mode and Live Preview

The CM6 editor should show a clean review experience by default:

1. Delimiters are visually hidden or deemphasized when the cursor is outside the mark.
2. Mark contents are styled by type:
   - additions: inserted text styling
   - deletions: deleted text styling
   - substitutions: old text and new text shown as a replacement pair
   - comments: compact inline comment indicator or popover
   - highlights: highlight styling, optionally with adjacent comment indicator
3. Raw syntax becomes visible and editable when:
   - the cursor or selection intersects the mark
   - the user toggles "show raw CriticMarkup"
   - the parser detects invalid syntax
4. All edits are normal CM6 transactions so Obsidian undo and Relay synchronization continue to work.

### Display Modes

The plugin has two rendered display modes. These modes affect editor decorations and reading mode rendering only; switching modes never rewrites the Markdown file.

1. Review mode: show suggestions and comments without showing raw delimiters. This is the default.
2. Clean mode: show a preview of the document as if all suggestions were accepted.
3. Raw mode: show CriticMarkup source text and delimiters for inspection and manual editing.

Review mode rendering policy:

1. Render additions as inserted text.
2. Render deletions as deleted text.
3. Render substitutions as old text plus new text.
4. Render comments as unobtrusive comment indicators or popovers.
5. Render highlights as highlighted text.

Clean mode rendering policy:

1. Render additions as normal text.
2. Omit deletions.
3. Render substitutions as only the new text.
4. Hide comments.
5. Render highlights as normal text.

Raw mode rendering policy:

1. Do not rewrite reading-mode text.
2. Keep raw CriticMarkup visible in the editor.
3. Continue to show review cards in the sidebar so the user can still navigate and resolve marks.

The plugin should provide:

1. A command palette action to cycle the current note between review mode, clean mode, and raw mode.
2. A view action button for the same current-note switch.
3. A global setting for the default display mode, initially `review`.
4. A note-specific override stored in plugin data keyed by vault path. The override is local UI state and is not written into the Markdown file.
5. A right-sidebar tab that is registered and selectable when Markdown is open, but not forced to the front on startup.

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
10. Toggle raw CriticMarkup visibility.
11. Switch current note between review mode, clean mode, and raw mode.
12. Open review sidebar.
13. Finalize for publish, equivalent to accepting all marks.
14. Add comment to the current selection, opening a sidebar draft card for text entry.

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

1. Header with the active note name, display mode switch, and counts for suggestions and comments.
2. A compact filter row for mark type, author, and unresolved/actionable items.
3. A draft card for new comments when the user is adding a comment to the current selection.
4. A document-ordered list of review cards. Each card represents one CriticMarkup mark, or one highlight plus immediately following comment when they form a standard highlighted-comment pair.
5. Card body showing the proposed text change or comment text without raw delimiters.
6. Card metadata showing mark type, document location, and Relay-derived author when available.
7. Inline card actions:
   - locate mark in note
   - accept suggestion
   - reject suggestion
   - reply by inserting an adjacent CriticMarkup comment
   - remove comment/highlight
   - reveal raw source
8. Empty state for notes with no CriticMarkup marks.
9. Unavailable state when no Markdown note is active.

Sidebar/editor synchronization:

1. Selecting a card scrolls the editor to the mark and briefly highlights it.
2. Moving the cursor into a mark selects the matching sidebar card when the sidebar is open.
3. Accepting or rejecting from the sidebar performs the same source transformation as the command palette action.
4. The sidebar updates from CM6 document changes and reading-mode file changes without requiring a manual refresh.

Comment creation:

1. Selecting text should show an inline comment affordance near the selection.
2. Right-clicking selected editor text should include "Add CriticMarkup comment".
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
  relay/
    api.ts
    attribution.ts
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

## Relay Integration

### Dependency Model

Relay is optional. The CriticMarkup plugin should discover Relay at runtime through Obsidian's plugin registry, not by importing Relay source.

Current Relay code uses plugin id `system3-relay` and already exposes internal objects such as `_liveViews`, `sharedFolders`, and `metadataBridge`. This spec proposes adding a public API object to Relay instead of consuming those private fields.

### Proposed Relay Public API

Relay should expose a stable object on its plugin instance:

```ts
export interface RelayPublicApiV1 {
  version: 1;
  users: RelayUsersApi;
  documents: RelayDocumentsApi;
  attribution: RelayAttributionApi;
  awareness: RelayAwarenessApi;
}

export interface RelayUserSummary {
  id: string;
  name: string;
  email?: string;
  picture?: string;
  color: string;
  colorLight: string;
}

export interface RelayUsersApi {
  getUser(id: string): RelayUserSummary | null;
  listUsers(): RelayUserSummary[];
  subscribe(callback: () => void): () => void;
}

export interface RelayDocumentsApi {
  getContext(path: string): RelayDocumentContext | null;
}

export interface RelayDocumentContext {
  path: string;
  guid: string;
  sharedFolderPath: string;
  connected: boolean;
}

export interface RelayAttributionApi {
  getTextAttribution(
    path: string,
    ranges: Array<{ from: number; to: number }>,
  ): RelayAttributionRange[];
  subscribe(path: string, callback: () => void): () => void;
}

export interface RelayAttributionRange {
  from: number;
  to: number;
  userId: string | null;
}

export interface RelayAwarenessApi {
  getOnlineUsers(path: string): RelayUserSummary[];
  subscribe(path: string, callback: () => void): () => void;
}
```

This API can initially be implemented using the same Yjs item attribution logic already present in Relay's `UserAttributionPlugin`, but the logic should live behind Relay's public API.

### Suggestion Attribution Algorithm

CriticMarkup does not have native author fields. MVP author identity is Relay-derived only. The plugin should not parse or write structured author metadata inside CriticMarkup marks for the first usable version.

When Relay attribution is available:

1. Addition author: author of the opening `{++` delimiter, falling back to majority author across delimiters and added text.
2. Deletion author: author of the opening `{--` delimiter, falling back to majority author across delimiters.
3. Substitution author: author of the opening `{~~` delimiter or `~>` separator, falling back to majority author across delimiters and new text.
4. Comment author: majority author of the comment body, falling back to delimiter author.
5. Highlight author: author of the opening `{==` delimiter, falling back to highlighted text majority.

This deliberately distinguishes "who wrote the original prose" from "who created the suggested change."

### Relay-Aware UI

When Relay data is available, the plugin should show:

1. Author chip/avatar on comment popovers and suggestion widgets.
2. Review sidebar filters by author, mark type, and file.
3. Online/offline presence for users attached to open shared documents.
4. Tooltips showing author name and suggestion type.

When Relay data is unavailable:

1. Keep all CriticMarkup features active.
2. Hide author-specific controls.
3. Display comments using only their plain text content.

## Settings

Initial settings:

1. Default display mode: `review`, `clean`, or `raw`, initially `review`.
2. Editor raw syntax behavior: `hideOutsideSelection`, `alwaysShow`, `alwaysHide`.
3. Show author chips when Relay is available.
4. Show inline action controls.
5. Enable review sidebar.

## Testing Strategy

Unit tests:

1. Parser fixtures for all five mark types.
2. Parser invalid syntax cases.
3. Accept/reject transformations.
4. Reading-mode render policy output.
5. Attribution-owner selection from mocked Relay ranges.

Integration tests:

1. CM6 decorations hide delimiters outside selection.
2. Commands produce expected source text.
3. Reading mode hides raw delimiters.
4. Relay absent: plugin still works.
5. Relay present: author chips render from mocked public API.
6. Review sidebar lists marks for the active note and applies accept/reject actions.

Manual Obsidian checks:

1. Source mode, live preview, and reading mode.
2. Undo/redo after accept/reject.
3. Files inside and outside Relay shared folders.
4. Review sidebar selection stays synchronized with the editor.
5. Mobile or constrained-width editor behavior if this becomes a release target.

## Open Questions

1. Should accept/reject all operate on the whole file immediately, or require confirmation when more than one mark is present?
2. How much raw syntax should be exposed in live preview while the cursor is inside a mark?
3. Should Relay expose this API as `plugin.api`, `plugin.relayApi`, or another namespaced property?

## Phase Plan

### Phase 1 - Standalone CriticMarkup MVP

1. Scaffold Obsidian plugin.
2. Implement parser and transformations.
3. Add CM6 decorations and commands.
4. Add reading-mode postprocessor for simple, safe marks.
5. Add tests for parser, transforms, and rendering policy.

### Phase 2 - Relay Public API

1. Add `RelayPublicApiV1` to Relay.
2. Move attribution range logic behind the API.
3. Add mocked Relay API integration in this plugin.
4. Add author chips and review sidebar filters.

### Phase 3 - Robust Review UX

1. Add full review sidebar.
2. Improve reading-mode rendering for marks crossing Markdown-rendered element boundaries.
3. Add navigation and batch actions.
4. Add edge-case tests for large files and concurrent edits.
