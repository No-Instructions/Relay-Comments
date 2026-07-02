# CriticMarkup for Relay and Obsidian - Phase 0 Spec

## Status

Draft for discussion. This project is an Obsidian community plugin that adds CriticMarkup authoring, rendering, and review UI to Markdown notes. It is designed to work as a standalone CriticMarkup plugin and to gain collaboration-aware features when the Relay plugin is installed.

## Goals

1. Add first-class CriticMarkup support to Obsidian's CodeMirror 6 editor.
2. Keep the Markdown file as the source of truth. Suggestions, deletions, comments, and highlights are stored as plain CriticMarkup text.
3. Hide raw CriticMarkup delimiters in Obsidian Live Preview and Reading mode. Raw CriticMarkup is visible only in Obsidian Source mode.
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
5. Card metadata showing mark type, document location, and Relay-derived author when available.
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

### Relay as Identity Provider

Relay should be the identity provider for review UI, but CriticMarkup remains the document markup owner. The boundary is:

1. Relay answers identity questions: who am I, who is this user ID, who authored this source range, who is online.
2. CriticMarkup answers review questions: what marks exist, how are they rendered, what source edits accept/reject/resolve should perform.
3. CriticMarkup must not read Relay internals such as `_liveViews`, Yjs maps, auth stores, or `RelayManager.users` directly.
4. Relay must not need to know CriticMarkup syntax to provide identity. It only needs to answer path/range/user queries.

Relay already has the pieces this API needs:

1. Plugin id `system3-relay`.
2. `LoginManager.user` / `RelayManager.user` for the signed-in user.
3. `RelayManager.users` for durable user lookup.
4. Provider awareness state with `user.id`, `user.name`, `user.color`, and `user.colorLight`.
5. Yjs item attribution logic in `UserAttributionPlugin`, including offline fallback colors.

### Proposed Relay Public API

Relay should expose a stable object on its plugin instance:

```ts
export interface RelayPublicApiV1 {
  version: 1;
  identity: RelayIdentityApi;
  documents: RelayDocumentsApi;
  attribution: RelayAttributionApi;
  awareness: RelayAwarenessApi;
}

export interface RelayUserSummary {
  id: string;
  name: string;
  picture?: string;
  color: string;
  colorLight: string;
}

export interface RelayIdentityApi {
  getCurrentUser(path?: string): RelayUserSummary | null;
  resolveUser(userId: string): RelayUserSummary | null;
  listUsersForPath(path: string): RelayUserSummary[];
  subscribe(callback: () => void): () => void;
}

export interface RelayDocumentsApi {
  getContext(path: string): RelayDocumentContext | null;
}

export interface RelayDocumentContext {
  path: string;
  guid: string;
  sharedFolderPath: string;
  relayId: string | null;
  sharedFolderGuid: string;
  connected: boolean;
  localOnly: boolean;
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
  confidence: "exact" | "majority" | "unknown";
}

export interface RelayAwarenessApi {
  getOnlineUsers(path: string): RelayUserSummary[];
  subscribe(path: string, callback: () => void): () => void;
}
```

Relay should announce API availability with a workspace event after load and after reload:

```ts
app.workspace.trigger("system3-relay:api-ready", relayApi);
```

CriticMarkup should also poll the plugin registry on load because plugin load order is not guaranteed:

```ts
const relay = app.plugins.plugins["system3-relay"] as
  | { api?: RelayPublicApiV1 }
  | undefined;
```

The API must not expose auth tokens. Email should not be included in `RelayUserSummary` for CriticMarkup unless there is a deliberate privacy setting, because comments may be visible in screenshots and exports.

### CriticMarkup Consumer API

This plugin should wrap Relay in an adapter so the rest of the code does not know whether Relay is present:

```ts
export interface ReviewIdentityProvider {
  getCurrentAuthor(path: string): ReviewAuthor | null;
  resolveAuthor(userId: string): ReviewAuthor | null;
  getAuthorForMark(path: string, mark: CriticMark): ReviewAuthor | null;
  getOnlineAuthors(path: string): ReviewAuthor[];
  subscribe(path: string, callback: () => void): () => void;
}

export interface ReviewAuthor {
  provider: "relay";
  id: string;
  name: string;
  picture?: string;
  color: string;
  colorLight: string;
}
```

Resolution order for a sidebar card:

1. If the mark has compatible imported metadata with a Relay user ID, call `resolveAuthor`.
2. Otherwise call `getAuthorForMark`, which asks Relay attribution for mark-specific source ranges.
3. If Relay is missing, the file is outside Relay, or attribution is unknown, render a neutral local reviewer identity.

On comment or suggestion creation, CriticMarkup should ask `getCurrentAuthor(path)` so the draft card can show the current Relay identity immediately. The source edit remains a normal editor transaction so Relay synchronization continues to work.

### Persisting Author Identity

Core CriticMarkup does not define author fields. The default MVP should not invent a new source format for authors. For shared Relay documents, author identity is derived from Relay attribution and user lookup.

The plugin may read compatibility metadata from imported Track Changes-style comments, for example `{{author="Daniel" date="2026-07-01">>comment<<}}`, but this is compatibility input, not the primary write format.

If durable author stamps are needed outside Relay-shared files, add an explicit later setting. That setting should write a documented compatibility metadata format with:

1. Relay user ID when available.
2. Display-name snapshot for offline reading.
3. Creation timestamp.
4. No auth token or email.

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

1. Show author chips when Relay is available.
2. Show inline comment controls.
3. Enable review sidebar.

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

1. Source mode, Live Preview, and Reading mode.
2. Undo/redo after accept/reject.
3. Files inside and outside Relay shared folders.
4. Review sidebar selection stays synchronized with the editor.
5. Mobile or constrained-width editor behavior if this becomes a release target.

## Open Questions

1. Should accept/reject all operate on the whole file immediately, or require confirmation when more than one mark is present?
2. Should Relay expose this API as `plugin.api`, `plugin.relayApi`, or another namespaced property?

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
