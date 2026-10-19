# Inkdrop integration: API survey and fit for orc

Date: 2026-10-18. API facts come from the Inkdrop developer docs (developers.inkdrop.app), the user
manual (docs.inkdrop.app) and the official MCP server's README (`inkdropapp/mcp-server`). Items
marked ⚠ are not documented and need a live check.

Context: Inkdrop is the user's knowledge base. Use it as the place where the user and the
orchestrator share a feature: specs queued from any device, a live task list, a durable log, and
recall of earlier notes. See [ADR-0011](../adr/0011-inkdrop-feature-note.md).

## 1. Ways in

- **Local HTTP server** (Preferences → Local Server; also started when the MCP server is enabled):
  default bind `127.0.0.1`, port `19840`, HTTP Basic auth. Credentials are stored encrypted in
  the app's `config.json`, and access logs go to `<user data>/server.log`. `GET /` returns
  `{"version": "...", "ok": true}`.
- **Official MCP server** (`npx -y @inkdropapp/mcp-server`, stdio). It wraps the local server and
  is configured by `INKDROP_LOCAL_SERVER_URL`, `INKDROP_LOCAL_USERNAME` and
  `INKDROP_LOCAL_PASSWORD`. Its tools are `search-notes`, `list-notes`, `read-note`,
  `read-backlinks`, `create-note`, `update-note`, `patch-note`, plus books, tags and files.
  `search-notes` and `list-notes` truncate bodies to 200 characters, so use `read-note` for the
  full text.
- **Plugins** (`init.js`, packages): an in-app JS API with commands, `env.localDB`, app state and
  UI components. Not used by orc yet.
- No CLI, URL-scheme API or webhooks are documented. Notes link as `inkdrop://note/<id without
  "note:">`.

Sources: <https://developers.inkdrop.app/guides/integrate-with-external-programs>,
<https://developers.inkdrop.app/data-access/local-http-server>,
<https://docs.inkdrop.app/reference/mcp-server>, <https://github.com/inkdropapp/mcp-server>

## 2. Local server endpoints used by orc

| Method | Path | Notes |
|---|---|---|
| GET | `/` | Meta, `version`. Used as the doctor probe. |
| GET | `/notes` | `keyword` (in-app search qualifiers: `book:`, `tag:`, `status:`, `title:`), `limit` (default 50), `skip`, `sort`, `descending`. |
| GET | `/note:<id>` | One note. |
| POST | `/notes` | Create, or update with the current `_rev`. A stale `_rev` returns 409 `{"ok":false,"error":"Document update conflict"}`. Writes return `{ ok, id, rev }`. |
| POST | `/note:<id>` | Partial update merged into the latest revision, with no `_rev` check. orc avoids it for `body`. |
| GET / POST | `/books`, `/tags` | List, create (`{ name }`; tags also take `color`). |
| GET | `/_changes` | `since`, `limit`, `include_docs`. No `live` mode, so polling only. |

`DELETE /note:<id>` deletes permanently and skips the trash. orc never deletes. ⚠ The documented way to
trash a note, `POST /note:<id>` with `{"bookId": "trash"}`, returned 400 "invalid bookId" on
Inkdrop 6.2.0 (2026-10-19). The MCP's `update-note` with `bookId: trash` failed the same way.

## 3. Note model

`_id` (`note:<random>`), `_rev`, `title`, `body` (Markdown), `doctype` (`markdown`), `bookId`,
`tags` (tag ids), `status` (`none | active | onHold | completed | dropped`), `share`, `pinned`,
`createdAt` / `updatedAt` (ms), and `numOfTasks` / `numOfCheckedTasks`, which are derived from body
checkboxes. That derivation gives the note list a progress bar for free.

## 4. Fit

- Writes go through a deterministic CLI (`orc inkdrop`): no tokens spent on bodies, and the
  user's text outside a managed block is never touched. Reads for recall go through MCP, because
  choosing what to read takes judgment.
- Checked live on 2026-10-19 against Inkdrop 6.2.0:
  - `inbox`, `claim`, `push` (block and checkboxes; `numOfTasks` 2 / `numOfCheckedTasks` 1), a
    user edit followed by `pull` (`changed: yes`, then `no`), and `push --done` (status
    `completed`). The spec text was unchanged throughout.
  - A stale `_rev` returns 409.
  - The preview hides the `<!-- orc:begin/end -->` lines (the editor shows them dimmed) and shows
    the progress bar ("1 of 2 tasks").
  - Completed notes leave the default note list (Status → Completed shows them), but search
    still finds them, so recall keeps working.
