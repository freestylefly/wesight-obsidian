# WeSight Obsidian

WeSight Obsidian is a desktop-only Obsidian plugin that brings local agent runtimes into a vault workspace. The MVP supports Claude Code, Codex, and OpenCode with local CLI detection, confirmed managed installs under `~/.wesight/runtimes`, provider profiles, sidebar chat, inline edit, slash commands, vault file mentions, and unlisted internet sharing for the current Markdown note.

## Internet Sharing

Use the share icon in a Markdown note title bar or run `WeSight: Share current note to internet`. Sign in with WeSight, publish a manual snapshot, then copy, view, update, disable, or restore the same `share.wesight.ai` link.

Published snapshots support common Markdown, tables, task lists, code blocks, formulas, and local PNG, JPEG, GIF, or WebP images. Wiki links become visible text. Frontmatter, embedded notes, and Mermaid source stay local; the share panel warns before publishing omitted content.

Internet sharing requires Obsidian 1.11.4 or later so the refresh token can use Obsidian SecretStorage.

## Feishu Documents

Open the share popover and choose `Feishu Documents`. On the first connection for a computer, WeSight installs its managed `@larksuite/cli` runtime under `~/.wesight/runtimes/lark-cli`, installs the complete official Feishu Agent Skills set, and configures the Feishu application.

Authorization uses `lark-cli auth login --domain all --no-wait --json`. Scan the QR code with the Feishu mobile app and approve every permission shown on the official Feishu page. WeSight verifies the token, the complete application scope list, and read access for messages, documents, Base, calendar, and Drive. The CLI and the operating system credential store retain tokens; the vault, frontmatter, plugin logs, and `authorization.json` never contain access tokens, refresh tokens, device codes, or authorization URLs.

The managed installation and authorization are shared by every vault and the WeSight desktop app on the same computer. Reauthorization is requested when the token expires, access is revoked, the granted scope set is incomplete, or WeSight raises its required scope version.

## WeChat Official Account Drafts

Open the share popover and choose `公众号草稿`, or run
`WeSight: 同步当前笔记到公众号草稿箱`. Configure one Official Account in
`WeSight → 发布平台`, then open the docked preview to inspect the title, author,
summary, cover, warnings, and final Canghe Style article before syncing.

The first sync creates a draft and stores only the internal
`wesight-wechat-draft-id` linkage in frontmatter. Later syncs update that draft,
while `另存为新草稿` creates a separate draft. AppSecret and WeChat access tokens
are encrypted in WeSight Cloud and never enter the vault or plugin data.

Publishing requires the WeSight fixed-egress gateway IP to be present in the
Official Account allowlist. The account must have access to the material,
article image, and draft APIs.

## Development

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
```

The plugin package files are `main.js`, `manifest.json`, and `styles.css`.
