# WeSight for Obsidian

Run Claude Code, Codex, and OpenCode as local AI collaborators inside an Obsidian vault. WeSight provides a sidebar chat, inline editing, model-provider profiles, file mentions, slash commands, internet sharing, Feishu document publishing, and WeChat Official Account draft publishing.

## Requirements

- Obsidian 1.11.4 or later on desktop.
- At least one supported agent CLI installed independently: [Claude Code](https://code.claude.com/), [Codex](https://github.com/openai/codex), or [OpenCode](https://opencode.ai/).
- The optional Feishu workflow requires an independently installed [Lark CLI](https://github.com/larksuite/cli#installation).
- Optional Skill-generated WeChat themes require an independently installed [gzh-design Skill](https://github.com/isjiamu/gzh-design-skill).

WeSight detects existing executables from the configured path, the system path, and compatible legacy WeSight runtime locations. It does not install or update CLI tools, agent runtimes, or their dependencies.

## Features

### Local agent chat

1. Open **Settings → WeSight** and select Claude Code, Codex, or OpenCode.
2. Confirm that WeSight detects the CLI, or enter its executable path.
3. Open the WeSight sidebar from the ribbon or command palette.
4. Chat with the selected agent, mention vault files, switch models, or use slash commands.

Local chats and inline edits run the selected CLI as a child process. Agent capabilities, provider requests, tool calls, file access, and approval behavior follow that CLI's own configuration.

### Inline editing

Select text in a Markdown note and run **WeSight: Inline edit**. Review the proposed replacement before applying it.

### Internet sharing

Use the share icon in a Markdown note title bar or run **WeSight: Share current note to internet**. After signing in to WeSight, you can publish a snapshot, copy its `share.wesight.ai` link, update it, disable it, restore it, and choose whether readers can comment.

Published snapshots support common Markdown, tables, task lists, code blocks, formulas, and local PNG, JPEG, GIF, or WebP images. Wiki links become visible text. Frontmatter, embedded notes, and Mermaid source remain local; the sharing panel displays warnings before publishing omitted content.

### Feishu documents

Open the sharing panel and choose **Feishu Documents**. WeSight detects your existing `lark-cli`, guides you through the official Feishu configuration and authorization flow, and can create or update a document in your Feishu Drive.

Lark CLI and the operating system credential store retain Feishu tokens. WeSight stores a non-secret authorization status record at `~/.wesight/lark/authorization.json`. The vault, note frontmatter, and WeSight logs do not store Feishu access tokens, refresh tokens, device codes, or authorization URLs.

### WeChat Official Account drafts

Open the sharing panel and choose **公众号草稿**, or run **WeSight: 同步当前笔记到公众号草稿箱**. Configure an Official Account under **Settings → WeSight → 发布平台**, preview the rendered article, and then create or update a cloud-managed draft.

This workflow requires a WeSight account and a WeChat Official Account with access to the material, article-image, and draft APIs. The WeSight fixed-egress IP must be added to the account allowlist. AppSecret and WeChat access tokens are encrypted by WeSight Cloud and do not enter the vault or plugin data.

Canghe Style is the default local template. The theme selector can also generate layouts with the installed gzh-design Skill through the currently selected agent CLI, provider profile, and model. Skill generation sends the article Markdown to that provider, preserves image references as local tokens, validates the generated inline HTML, and caches successful results locally. Image bytes are uploaded only when you explicitly create or update a WeChat draft.

## Accounts and network use

Local chat and inline editing do not require a WeSight account. A WeSight account is required for internet sharing and WeChat publishing. Feishu publishing uses the account configured by Lark CLI.

The plugin connects to remote services only for features that need them:

- `api.wesight.ai` handles WeSight sign-in, share snapshots, share assets, comments configuration, and WeChat draft operations.
- `share.wesight.ai` hosts links created by the internet-sharing feature.
- The provider URL selected in settings may be contacted to load its model list. Agent subprocesses contact providers according to their own configuration.
- Generating a Skill-based WeChat theme sends the article Markdown to the provider used by the selected agent configuration.
- Lark CLI contacts Feishu when you configure, authorize, create, or update a document.
- Remote images referenced by a note may be downloaded when generating a WeChat preview or draft.

Note text and supported local images are sent to WeSight Cloud only after you explicitly publish or update an internet share or WeChat draft. WeSight does not include client-side telemetry or advertising.

## Data and file access

WeSight reads the active note and files you explicitly mention or publish. It writes conversation data under `.wesight/` in the current vault and may update WeSight-owned frontmatter fields when linking a note to a share, Feishu document, or WeChat draft.

The desktop plugin also accesses these paths outside the vault:

- `~/.wesight/providers.json` stores non-secret provider metadata.
- Obsidian SecretStorage stores provider API keys and the WeSight refresh token.
- `~/.wesight/tmp/` contains permission-restricted per-run provider configuration, which can include a provider API key and is removed when the subprocess finishes.
- `~/.wesight/cache/wechat-themes/` stores validated generated WeChat theme HTML and invalidates entries when the article, Skill, provider profile, or model changes.
- `~/.wesight/logs/` contains local operational logs.
- `~/.wesight/lark/authorization.json` records non-secret Feishu authorization status.
- Existing CLI executables and their configuration files are read or executed as needed. Compatible legacy executables under `~/.wesight/runtimes/` can still be detected.

## Development

```bash
npm ci
npm test
npm run lint
npm run build
```

The release assets are `main.js`, `manifest.json`, and `styles.css`.

## Support

Report bugs and request features through [GitHub Issues](https://github.com/freestylefly/wesight-obsidian/issues).

## License

[MIT](LICENSE)
