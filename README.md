# WeSight for Obsidian

Run Claude Code, Codex, and OpenCode as local AI collaborators inside an Obsidian vault. WeSight provides a sidebar chat, inline editing, model-provider profiles, file mentions, slash commands, internet sharing, Feishu document publishing, and WeChat Official Account draft publishing.

## Requirements

- Obsidian 1.11.4 or later on desktop.
- At least one supported agent CLI installed independently: [Claude Code](https://code.claude.com/), [Codex](https://github.com/openai/codex), or [OpenCode](https://opencode.ai/).
- The optional Feishu workflow requires an independently installed [Lark CLI](https://github.com/larksuite/cli#installation).
- Skill-generated WeChat themes use the bundled [gzh-design Skill](https://github.com/isjiamu/gzh-design-skill). A compatible local installation can still override the bundled copy for development.

WeSight detects existing executables from the configured path, the system path, and compatible legacy WeSight runtime locations. It does not install or update CLI tools, agent runtimes, or their dependencies.

## Features

### 1.4.0 release

The [1.4.0 update](docs/releases/1.4.0.md) adds the browser dynamic publishing center, X posts in quick conversion, centralized browser connector settings, and membership checks for conversion and browser handoff. It also improves generated copy limits and skips automatic Git sync while offline. Update the [browser publishing assistant to 1.1.0](https://github.com/freestylefly/wesight-chrome/releases/tag/v1.1.0) alongside the plugin. Use **版本更新说明** in the avatar menu or general settings to read this release and recent version changes offline.

### GitHub team collaboration

The WeSight avatar menu provides current-repository status, **立即拉取**, **推送提交**, sync settings, and recent activity. **Settings → WeSight → 仓库同步** configures optional automatic pull, push, idle commits, and pull on vault open. Automation starts disabled and is saved per vault on each device, outside the shared vault. Existing Git credentials and upstream branches are reused. Local edits and conflicts pause the affected operations; independent team changes can merge normally. See [GitHub collaboration](docs/git-sync.md) for scope, configuration, and recovery.

### Article-to-social workbench (1.0.0)

**转为图文** and connecting the browser publishing assistant require an active WeSight membership. Free and expired accounts receive a membership prompt with a link to recharge. Membership is refreshed before generation, connecting, and publishing; existing paired connections and task links also require membership when handing off content.

Use **转为图文** in the WeSight header, note toolbar, file menu, or command palette to open the right-side workbench while keeping the original note visible. **快速转** prepares Xiaohongshu, Weibo image posts, Jike posts, and X posts with shared or platform-specific copy. X gets complete short sentences within its 280 weighted-character limit, including topics; Chinese characters usually count as two. Its first four supported PNG/JPEG/WebP images are sent, up to 5 MB each, with skipped images reported and other platforms left intact. Review and edit copy in place and select/reorder original article images. The one-click publishing action opens the browser extension's **动态** composer with each platform's copy, images, and Jike circle preserved; start syncing there when ready. The extension also supports creating dynamics directly with text, images, or a video, without connecting Obsidian.

Generated social copy targets 600–900 characters and stays within 1,000 characters including topics, spaces, and line breaks. The Xiaohongshu editor shows the combined count and blocks syncing overlong manual edits so the text can be shortened before sending.

Connect the browser publishing assistant in **Settings → WeSight → General → Connectors**. Installation instructions, connection status, reconnecting, and updates are available there. Sending content with no active connection opens this settings card and keeps the generated copy and images. Connecting pairs the extension without sending a note or creating a publishing task.

The Xiaohongshu image workspace offers local typography templates and a separate AI-image gallery with style selection, reference images, aspect ratios, single-image regeneration, and ordering. Generation uses your configured compatible agent/provider; AI image generation requires image-generation support. Inputs may be sent to that provider according to its configuration. Local drafts and generated assets are stored under `.wesight/` in the vault.

An active membership is required for both single-platform and multi-platform conversion and browser handoff. Free and expired accounts see a prompt with **去充值会员**, which opens the existing membership checkout. Edited text, images, and saved tasks stay available for use after renewal.

### Browser-assisted platform drafts (1.0.0)

**分享 → 多平台** opens the browser's **WeSight publish center** with the current note already imported. In the publish center you can adjust the title, summary, cover, and Markdown body, then tick Zhihu, CSDN, Juejin, Bilibili articles, Toutiao, Weibo articles, or X Articles and start syncing. The publish center also imports local `.md` files (select the images alongside them) and article links. The social workbench additionally prepares Xiaohongshu image posts, Weibo image posts, and Jike posts.

Install the latest [WeSight Publish Assistant](https://github.com/freestylefly/wesight-chrome/releases) in Chrome, Edge, or Arc and follow the one-time local pairing flow; older extension versions are asked to update. The plugin starts a temporary HTTP service bound only to `127.0.0.1`. The article handoff expires after ten minutes, and sync progress is reported back to Obsidian for two hours. Article and image transfer to the extension does not use WeSight Cloud. The extension keeps the current publish-center draft in its local browser storage and uploads to the platforms you choose using the browser's existing signed-in session. The extension uses the same WeSight account system and displays the verified profile in its header. Free users sync one platform at a time; members can select several. The extension restores your previous platform choices, uses the first body image as the default cover, previews with the Canghe green theme, and checks X’s 15-image limit only when X is selected. Leading publication badges are removed from the publishing copy.

The publish center shows per-platform status, editor links, login recovery, and retries. All workflows stop at an editable draft: **you perform the final Publish action**. The existing WeChat draft service continues separately.

### 词元API and grouped model selection

Claude Code also supports [词元API](docs/ciyuan.md), listed immediately after TokenDance. Enter an API key, fetch your account’s chat models, and choose a default. 词元API models are grouped by manufacturer in settings and the two-column chat picker, with search and collapsible groups.

The [1.2.2 update](docs/releases/1.2.2.md) renames OpenLux to 词元API and uses `https://ciyuan.today/v1`. Existing API keys and model selections carry over automatically. See the release notes for upgrade and validation details.

### Member models and usage (1.1.0)

Claude Code supports WeSight member models through the recommended configuration, or a personal TokenDance connection. The account menu shows the remaining weekly allowance next to **使用情况** and opens the web dashboard with model usage and reset times. Existing installations retain their selected configuration; model availability follows the account's current entitlement.

See the [1.1.0 release notes](docs/releases/1.1.0.md) for the complete Chinese update summary and upgrade instructions.

### Local agent chat

The [1.2.1 patch](docs/releases/1.2.1.md) fixes duplicated Claude Code replies and thinking content while preserving live streaming.

1. Open **Settings → WeSight** and select Claude Code, Codex, or OpenCode.
2. Confirm that WeSight detects the CLI, or enter its executable path.
3. Open the WeSight sidebar from the ribbon or command palette.
4. Chat with the selected agent, mention vault files, attach or paste images, switch models, or use slash commands.

Local chats and inline edits run the selected CLI as a child process. Agent capabilities, provider requests, tool calls, file access, and approval behavior follow that CLI's own configuration.

Chat image input supports PNG, JPEG, WebP, and GIF files up to 25 MB each. Selected images are copied into the current vault, shown with the conversation, and passed to the selected agent CLI as local attachments. The CLI and its configured provider determine whether those image bytes leave the device.

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

Knowledge Brain contacts `api.wesight.ai` to verify member access and contacts GitHub after an eligible user explicitly enables it. The plugin also reads the manifest from the latest formal GitHub Release at startup and every six hours to discover updates. Update checks send no Vault content, account data, or device identifiers. Entitlement requests contain the existing account credential and do not include Vault content, questions, answers, file paths, or message identifiers. Claude Code or Codex may send the supplied prompt and evidence to the model provider selected by your existing agent configuration.

Local chat and inline editing do not require a WeSight account. A WeSight account with an active Creator membership is required for the Knowledge Brain internal test. A WeSight account is also required for internet sharing and WeChat publishing. Feishu publishing uses the account configured by Lark CLI.

The plugin connects to remote services only for features that need them:

- `api.wesight.ai` handles WeSight sign-in, Knowledge Brain member entitlements, share snapshots, share assets, comments configuration, and WeChat draft operations.
- `share.wesight.ai` hosts links created by the internet-sharing feature.
- GitHub Releases provides the latest formal WeSight plugin manifest for update discovery and hosts optional Knowledge Brain resources.
- GitHub Releases also hosts the separately installed Chrome/Edge publishing assistant. Local pairing and publishing tasks use `127.0.0.1`; the extension contacts the selected content platforms.
- The provider URL selected in settings may be contacted to load its model list. Agent subprocesses contact providers according to their own configuration.
- Generating a Skill-based WeChat theme sends the article Markdown to the provider used by the selected agent configuration.
- Lark CLI contacts Feishu when you configure, authorize, create, or update a document.
- Remote images referenced by a note may be downloaded when generating a WeChat preview or draft.

Note text and supported local images are sent to WeSight Cloud only after you explicitly publish or update an internet share or WeChat draft. WeSight does not include client-side telemetry or advertising.

## Data and file access

When Knowledge Brain is enabled, the plugin writes the runtime and install record under `~/.wesight/knowledge-brain/`. Reviewed operations create or update knowledge files under `wiki/`, immutable source snapshots under `.raw/`, and upstream transaction state under `.vault-meta/`. Permission-restricted transaction previews use `~/.wesight/tmp/knowledge-brain/` and are cleaned after confirmation, cancellation, failure, plugin shutdown, or the next startup. Operational logs contain action types, durations, versions, statuses, counts, and error codes; they exclude note content, questions, answers, file paths, message identifiers, and transaction payloads.

WeSight reads the active note and files you explicitly mention or publish. It writes conversation data under `.wesight/` in the current vault and may update WeSight-owned frontmatter fields when linking a note to a share, Feishu document, or WeChat draft. Images attached to chat are stored under `.wesight/input-images/` and removed with their conversation.

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
