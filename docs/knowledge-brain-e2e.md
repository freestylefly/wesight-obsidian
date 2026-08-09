# Knowledge Brain v1 acceptance

The internal-test build requires a signed-in WeSight Creator membership. Knowledge Brain operations do not consume credits.

Run this checklist on one Apple Silicon Mac and one Intel Mac before enabling the internal-test rollout.

## Baseline

- Install the release assets `main.js`, `manifest.json`, and `styles.css` in a clean Obsidian profile.
- Use a local filesystem Vault containing one byte-hashed existing Markdown note.
- Confirm Python 3.11 or later and either Claude Code or Codex are available.
- Keep a byte-level Vault snapshot before each fault-injection case.

## Five-function path

1. Open Settings → WeSight and enable Knowledge Brain.
2. Confirm the pinned 2.1.0 runtime, doctor result, both Agent availability fields, and retrieval capability status.
3. Collect the active Markdown note, review the preview, apply it, and open the resulting knowledge page.
4. Switch chat to Knowledge mode, ask one grounded question, continue with one follow-up, and open every cited wikilink.
5. Save one successful answer, confirm its question/answer scope, and open the saved path from the message state.
6. Run the health check, expand each severity group, and open one finding at its reported line when findings exist.
7. Compare the existing-note hash and confirm every new path belongs to the reviewed operation.

## Member access

- Logged out: confirm the settings card, chat switch, editor action, context menu, commands, and answer-save button open the sign-in prompt without downloading or writing anything.
- Free account: confirm the same entries open the membership prompt and the credit balance remains unchanged.
- Active member: confirm payment or sign-in refresh unlocks the entries without restarting Obsidian.
- Offline grace: obtain a valid token, disconnect the network, advance through the seven-day window, and confirm core operations lock when the signed expiry is reached.
- Online denial: expire the membership on the server and confirm the next forced refresh clears cached access immediately.
- Logout: confirm access locks immediately while existing knowledge pages, health checks, and interrupted-transaction recovery remain available.

## Isolation and privacy

- Switch a non-empty conversation between Chat and Knowledge modes and confirm a new conversation is created.
- Switch Claude and Codex in Knowledge mode and confirm each keeps a separate mode session.
- Compare the Vault before and after a knowledge query; every byte must match.
- Search local logs for note text, questions, answers, Vault paths, message identifiers, and transaction JSON. The search must return no match.
- Cancel installation, planning, query, and apply at separate checkpoints; restart Obsidian and confirm temporary packages are cleared.

## Fault injection

- Serve an archive with an invalid SHA, truncated body, path traversal, link entry, device entry, case collision, oversized file, excessive entries, and excessive expanded bytes.
- Test Python 3.10, Python 3.11 through 3.14, Homebrew paths, a custom PATH, and no Python.
- Test empty, large, adopted, partially adopted, and conflicting Vaults; repeat the enable click during installation.
- Return malformed, duplicated-marker, oversized, wrong-operation, out-of-scope, and prompt-injected drafts from each Agent.
- Change a target after preview, change the inspected hash, interrupt apply, corrupt a journal, and run the separately confirmed recovery action.
- Test a missing citation, ambiguous basename, explicit evidence gap, unavailable retrieval index, and a query that resembles a command-line option.
- Test empty/error/cancelled assistant messages, duplicate save attempts, and synthetic evidence that attempts to create an accepted claim.

Record the app version, CPU architecture, macOS version, Python version, Agent version, result, and failure artifact for every run.
