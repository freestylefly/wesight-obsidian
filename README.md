# WeSight for Obsidian

Run Claude Code, Codex, and OpenCode as local AI collaborators inside an Obsidian vault. WeSight provides a sidebar chat, inline editing, model-provider profiles, file mentions, slash commands, internet sharing, Feishu document publishing, and WeChat Official Account draft publishing.

## Requirements

- Obsidian 1.11.4 or later on desktop.
- At least one supported agent CLI installed independently: [Claude Code](https://code.claude.com/), [Codex](https://github.com/openai/codex), or [OpenCode](https://opencode.ai/).
- The optional Feishu workflow requires an independently installed [Lark CLI](https://github.com/larksuite/cli#installation).
- Skill-generated WeChat themes use the bundled [gzh-design Skill](https://github.com/isjiamu/gzh-design-skill). A compatible local installation can still override the bundled copy for development.

WeSight detects existing executables from the configured path, the system path, and compatible legacy WeSight runtime locations. It does not install or update CLI tools, agent runtimes, or their dependencies.

## Features

### Local agent chat

1. Open **Settings → WeSight** and select Claude Code, Codex, or OpenCode.
2. Confirm that WeSight detects the CLI, or enter its executable path.
3. Open the WeSight sidebar from the ribbon or command palette.
4. Chat with the selected agent, mention vault files, switch models, or use slash commands.

Local chats and inline edits run the selected CLI as a child process. Agent capabilities, provider requests, tool calls, file access, and approval behavior follow that CLI's own configuration.

### Knowledge Brain

Knowledge Brain is an opt-in local knowledge workflow powered by [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian). It is available as a member-only internal test and does not consume WeSight credits. The first release supports local macOS vaults, Python 3.11 or later, and Claude Code or Codex.

The plugin requests a signed entitlement from `api.wesight.ai` after WeSight sign-in. Active Creator members receive a token valid for at most seven days and no later than the membership expiry. A valid cached token keeps the local workflow available during a temporary network outage. When membership access ends, new enable, collection, query, answer-save, and preview-apply operations are locked; health checks, interrupted-transaction recovery, and existing local files remain available.

Enabling it downloads the pinned `claude-obsidian` 2.1.0 archive at commit `a3b3df4539802e150e942266fd310c1b5978a3c0`. WeSight accepts downloads from `github.com` and its `codeload.github.com` redirect, enforces bounded archive extraction, verifies SHA-256 `7c52eab5655da9735ef29903de3b1294e9d69c7b9fdb70b28aa7676dc3156870`, validates the package and contracts, and installs it under `~/.wesight/knowledge-brain/runtimes/claude-obsidian/2.1.0/`.

Vault adoption uses the exact reviewed dry-run parameters and only creates paths listed by that plan. Existing note bytes remain unchanged. Collection and answer saving use a read-only planning turn, deterministic transaction validation, a user-facing preview, and explicit confirmation. Knowledge queries run in a separate read-only session and verify Obsidian wikilinks before displaying the answer.

Available commands:

1. **开启知识大脑** — validate prerequisites and adopt the current vault.
2. **收录当前笔记到知识大脑** — plan and preview the active Markdown note.
3. **向知识大脑提问** — open a knowledge-mode conversation.
4. **保存最近 AI 回答到知识大脑** — preview the latest successful answer.
5. **知识大脑健康检查** — run the deterministic lint report.

Interrupted transactions pause new collection and saving. The settings status card then offers a separately confirmed recovery action.

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

Creating or updating an Official Account draft consumes one WeSight credit after
the sync succeeds. When the balance is empty, the plugin opens the membership and
credit prompt before uploading article assets. The external WeSight checkout uses
WeChat Native QR payment and the plugin refreshes the balance after payment.

After publishing the draft in WeChat, return to **分享 → 公众号** to save the published `mp.weixin.qq.com` article link. The panel then shows the note as published and can open the article in the system default browser.

This workflow requires a WeSight account and a WeChat Official Account with access to the material, article-image, and draft APIs. The WeSight fixed-egress IP must be added to the account allowlist. AppSecret and WeChat access tokens are encrypted by WeSight Cloud and do not enter the vault or plugin data.

Canghe Style is the default local template. The theme selector can also generate layouts with the bundled gzh-design Skill through the currently selected agent CLI, provider profile, and model. Six registered Skill themes are available, and **AI自定义主题** lets you name and describe a reusable style brief that is applied to the current article and retained for later articles. Skill generation sends the article Markdown and, for a custom theme, its style brief to that provider, preserves image references as local tokens, validates the generated inline HTML, and caches successful results locally. Image bytes are uploaded only when you explicitly create or update a WeChat draft.

## Accounts and network use

Knowledge Brain contacts `api.wesight.ai` to verify member access and contacts GitHub only after an eligible user explicitly enables it. Entitlement requests contain the existing account credential and do not include Vault content, questions, answers, file paths, or message identifiers. Claude Code or Codex may send the supplied prompt and evidence to the model provider selected by your existing agent configuration.

Local chat and inline editing do not require a WeSight account. A WeSight account with an active Creator membership is required for the Knowledge Brain internal test. A WeSight account is also required for internet sharing and WeChat publishing. Feishu publishing uses the account configured by Lark CLI.

The plugin connects to remote services only for features that need them:

- `api.wesight.ai` handles WeSight sign-in, Knowledge Brain member entitlements, share snapshots, share assets, comments configuration, and WeChat draft operations.
- `share.wesight.ai` hosts links created by the internet-sharing feature.
- The provider URL selected in settings may be contacted to load its model list. Agent subprocesses contact providers according to their own configuration.
- Generating a Skill-based WeChat theme sends the article Markdown to the provider used by the selected agent configuration.
- Lark CLI contacts Feishu when you configure, authorize, create, or update a document.
- Remote images referenced by a note may be downloaded when generating a WeChat preview or draft.

Note text and supported local images are sent to WeSight Cloud only after you explicitly publish or update an internet share or WeChat draft. WeSight does not include client-side telemetry or advertising.

## Data and file access

When Knowledge Brain is enabled, the plugin writes the runtime and install record under `~/.wesight/knowledge-brain/`. Reviewed operations create or update knowledge files under `wiki/`, immutable source snapshots under `.raw/`, and upstream transaction state under `.vault-meta/`. Permission-restricted transaction previews use `~/.wesight/tmp/knowledge-brain/` and are cleaned after confirmation, cancellation, failure, plugin shutdown, or the next startup. Operational logs contain action types, durations, versions, statuses, counts, and error codes; they exclude note content, questions, answers, file paths, message identifiers, and transaction payloads.

WeSight reads the active note and files you explicitly mention or publish. It writes conversation data under `.wesight/` in the current vault and may update WeSight-owned frontmatter fields when linking a note to a share, Feishu document, or WeChat draft.

The desktop plugin also accesses these paths outside the vault:

- `~/.wesight/providers.json` stores non-secret provider metadata.
- Obsidian SecretStorage stores provider API keys, the WeSight refresh token, and the signed Knowledge Brain entitlement token.
- `~/.wesight/tmp/` contains permission-restricted per-run provider configuration, which can include a provider API key and is removed when the subprocess finishes.
- `~/.wesight/cache/wechat-themes/` stores validated generated WeChat theme HTML and invalidates entries when the article, Skill, provider profile, model, or AI custom-theme brief changes.
- `~/.wesight/bundled-skills/gzh-design/` materializes the theme resources embedded in the plugin bundle.
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

Knowledge Brain internal-test builds must also complete the [Apple Silicon and Intel acceptance checklist](docs/knowledge-brain-e2e.md).

## Support

Report bugs and request features through [GitHub Issues](https://github.com/freestylefly/wesight-obsidian/issues).

## License

[GNU AGPL-3.0-or-later](LICENSE). Third-party runtime and bundled Skill notices are listed in [Third-Party Notices](THIRD_PARTY_NOTICES.md).
