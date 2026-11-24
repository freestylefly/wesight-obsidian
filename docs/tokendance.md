# TokenDance in Claude Code

Open WeSight settings → Claude → TokenDance (first provider). Select **连接 TokenDance**, complete the browser authorization, choose a model, then select **保存并用于 Claude Code**. The default model is `deepseek-v4.1-flash`.

The integration reuses the installed Claude Code CLI and its Anthropic client. No additional model SDK is required. Requests reach a loopback gateway protected by a random per-process credential. The gateway validates the exact model against TokenDance's public catalog and chooses the upstream protocol. Existing local Claude configuration files are not rewritten.

## Models and protocols

The following IDs and protocols were verified against the live catalog on 2026-09-20 (Asia/Shanghai):

| Model ID | Catalog supported_protocols | Selected upstream protocol |
| --- | --- | --- |
| `deepseek-v4.1-flash` | `openai:chat-completions`, `anthropic:messages`, `openai:responses` | Anthropic Messages |
| `glm-5.3-flash` | `openai:chat-completions`, `anthropic:messages` | Anthropic Messages |
| `glm-5.3` | `openai:chat-completions`, `anthropic:messages` | Anthropic Messages |
| `deepseek-v4-pro-0813` | `openai:chat-completions`, `openai:responses`, `anthropic:messages` | Anthropic Messages |
| `kimi-k3` | `openai:chat-completions`, `openai:responses` | OpenAI Chat Completions through the local Messages adapter |
| `hy4-preview` | `openai:chat-completions`, `openai:responses` | OpenAI Chat Completions through the local Messages adapter |

- Anthropic Base URL: `https://tokendance.space/gateway`; endpoint: `POST /v1/messages`.
- OpenAI Base URL: `https://tokendance.space/gateway/v1`; endpoint: `POST /chat/completions`.
- Discovery: `GET https://tokendance.space/gateway/v1/models`, without authentication.
- The live catalog is checked before saving and first execution, then cached for up to five minutes. Removed models and incompatible protocols fail closed. The display snapshot is never used to authorize execution.
- The compatibility adapter handles text, images, system prompts, tool selection, tool results, reasoning and SSE output. Unsupported content types return an error. Compatibility-mode token counting is a conservative local estimate, not upstream billing usage. Native token counting forwards `/v1/messages/count_tokens`.

## Authorization and configuration

Authorization follows the same S256 PKCE flow as WeSight desktop:

1. Open `https://tokendance.space/auth` with `callback_url`, `code_challenge`, `code_challenge_method=S256`, `app_url=https://wesight.ai`, and `key_name=WeSight Obsidian`.
2. Receive a one-time code on a randomly selected `127.0.0.1` port and unguessable callback path.
3. Exchange it at `POST https://tokendance.space/portal/api/v1/auth/keys`, using the original verifier.
4. Save the key directly to Obsidian SecretStorage under `wesight-tokendance-oauth-key`.

The provider profile stores the public gateway URL, selected model, available IDs and `wesight-credential:tokendance` reference. The actual OAuth key never enters profile JSON, exports or Claude Code's environment. At runtime, `ANTHROPIC_BASE_URL` points to the local gateway and `ANTHROPIC_AUTH_TOKEN` contains only its temporary credential. The selected ID is also projected into Claude's model-role environment variables.

Authorization can be cancelled and expires after ten minutes. Disconnect clears the local key, invalidates local runtime credentials and aborts active requests. Server-side key revocation is available on the TokenDance key management page. Plugin unload closes all listeners and active requests. Upstream error bodies are replaced with safe status/recovery messages.

## Verification

- Run `npm test -- tests/tokenDance.test.ts` for PKCE exchange, cancellation, protocol routing, secret isolation, streaming, tool round trips, unknown models and recovery errors.
- Run `npm run check` for the full test, lint, build and release-asset gate.
- In Obsidian, confirm TokenDance appears first under Claude and connect through browser authorization. The browser confirmation is performed by the account owner.
- Choose each model and use **测试连接**. This makes a small real request through the same loopback route used by Claude Code and consumes provider tokens.
- Save the model, start a Claude conversation and ask it to read a test note to verify tool execution. Test Kimi K3 or Hy4 separately to exercise protocol conversion.
- Live account authorization, balance availability and six-model generation require an authorized TokenDance account; mocked transport tests do not establish those results.

Sources: [Models](https://tokendance.space/docs/models), [Multi-protocol](https://tokendance.space/docs/multi-protocol), [Anthropic Messages](https://tokendance.space/docs/protocol-anthropic-messages), [OAuth](https://tokendance.space/docs/api-key-oauth), [Live catalog](https://tokendance.space/gateway/v1/models).

Reference implementation: adjacent WeSight desktop checkout, commit `8984cbe`, `src/main/libs/tokendance/service.ts`, `src/main/libs/claudeSettings.ts`, and `src/main/libs/coworkFormatTransform.ts`. The request/response converter is adapted from that implementation; plugin lifecycle, storage and streaming isolation are implemented locally.

## Verification record (2026-09-20)

- Full gate passed: 77 test files, 440 tests (including 16 TokenDance tests), lint without errors, TypeScript/build and release-asset verification. Lint reports four existing UI warnings and one Node-test environment warning.
- Final full-gate rerun also passed. The preceding attempt hit the existing adapter timing assertion at 2004 ms against a 2000 ms limit; an unchanged rerun passed all 440 tests.
- Installed the local build into `wesight-obsidian-vault`, preserving plugin data; reloaded Obsidian 1.13.7 and visually verified provider ordering, all six cards, native/compatibility labels and layout.
- Refreshed the live model catalog successfully inside Obsidian.
- With account-owner confirmation, completed the real S256 OAuth flow for `WeSight Obsidian`. Obsidian showed connected, including after a plugin reload. The key is stored only in SecretStorage.
- All six selected IDs passed real **测试连接** requests through the local gateway. The settings panel retains the last operation result for inspection.
- Saved TokenDance as Claude Code's default provider with `deepseek-v4.1-flash`. TokenDance is first in both settings presets and the chat supplier menu.
- Claude Code 2.1.223 returned `TOKEN_DANCE_CLAUDE_OK` through the native Messages path. Kimi K3 completed a real `Bash` tool call (`printf TOKEN_DANCE_TOOL_OK`) through the streaming compatibility path; the CLI session recorded the matching successful `tool_result`. No note contents were attached to these prompts.
- Existing Claude event rendering duplicates final text and omits the tool card in this host; CLI session evidence confirmed the tool execution. This pre-existing generic event-parser behavior was left outside the provider integration scope. The duplicated text was fixed separately in [1.2.1](releases/1.2.1.md).
- These smoke tests consumed provider tokens. Hy4 streaming/tool execution and image input were not separately tested against the live service; unit tests cover protocol conversion and streaming.
