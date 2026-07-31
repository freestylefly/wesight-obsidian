**Evidence**

- Source visual truth: `/Users/canghe/Library/Containers/at.EternalStorms.Yoink/Data/Documents/YoinkPromisedFiles.noIndex/yoinkFilePromiseCreationFolderA124438E-BC1D-495E-A284-0D4DDBF690F3/addA124438E-BC1D-495E-A284-0D4DDBF690F3/efd2d7d72106b3d8a51919bdb7e703e5.jpg`
- First-install implementation: `/Users/canghe/responsibilty/canghe/wesight-obsidian/qa-feishu-missing.png`
- QR authorization implementation: `/Users/canghe/responsibilty/canghe/wesight-obsidian/qa-feishu-authorization.png`
- Same-state combined comparison: `/Users/canghe/responsibilty/canghe/wesight-obsidian/qa-feishu-comparison.png`
- Runtime: Obsidian 1.12.7 with the production plugin artifact installed in `wesight-obsidian-vault`.
- State: mobile Feishu QR authorization waiting state. The CLI response was supplied by a temporary local QA fixture, so no real OAuth request, credential, permission grant, or Feishu write occurred.
- Viewport: 1163 × 768 capture pixels.
- Source dimensions: 822 × 666 pixels.
- Implementation dimensions: 1163 × 768 pixels.
- Density normalization: the implementation popover was cropped at 373 × 673 pixels and scaled to 369 × 666 pixels; the 822 × 666 source remained at native size. The normalized images were placed side by side in the combined comparison.
- Console and runtime errors: the Obsidian application log contained no WeSight, unhandled, exception, or failed entries from this QA run. The temporary CLI process exited after the popover closed.

**Findings**

- No open P0, P1, or P2 visual fidelity issue.
- The three-step hierarchy, large QR code, mobile Feishu instruction, waiting indicator, permission summary, browser fallback, and cancel action follow the source composition.
- The active step is “申请权限” because the current product flow defines QR scanning as step 2. This is an intentional workflow update from the older reference, which highlighted step 3.
- The compact 420 px anchored popover preserves the source hierarchy while fitting the Obsidian title-bar entry point.
- The capability list expands the reference from a short summary to five explicit checks: message, document, Base, calendar, and Drive.

**Required Fidelity Surfaces**

- Fonts and typography: Obsidian system typography remains legible across the title, stepper, QR instructions, capability labels, helper text, and actions. Weight and line-height preserve the reference hierarchy.
- Spacing and layout rhythm: the header, dual tabs, stepper, centered heading, QR-and-copy grid, waiting row, divider, five capability rows, primary fallback action, and cancel action fit without clipping in the captured viewport.
- Colors and visual tokens: the white surface, neutral dividers, Feishu blue active state, green completed step, subdued inactive step, and blue waiting indicator match the selected direction and existing plugin tokens.
- Image quality and asset fidelity: the generated QR remains sharp at 152 px, and the supplied Feishu logo is used in the disconnected state. UI icons come from Obsidian’s icon set.
- Copy and content: all four required prompts are visible, including the phone app instruction, all-permission instruction, five-capability summary, and waiting message. The official Feishu page is identified as the source of the real permission list.

**Primary Interactions Tested**

- Open the share popover from the active Markdown note title bar.
- Switch between “互联网分享” and “飞书文档”.
- Render the missing managed CLI state with five capability labels.
- Render the QR authorization state from an in-memory split-flow response.
- Keep the QR visible while the device-code process waits.
- Close the popover and cancel the waiting process.
- Remove the QA fixture and confirm the first-install state returns.

**Comparison History**

- First normalized comparison: no actionable P0, P1, or P2 mismatch was found.
- The older reference’s active third step was classified as expected product drift because the approved flow now uses “安装 CLI → 申请权限 → 完成授权”.
- No visual fix loop was required after the normalized comparison.

**Implementation Checklist**

- [x] Require a valid managed executable and matching `install.json`.
- [x] Ignore a system PATH CLI for first-install detection.
- [x] Serialize concurrent installation attempts.
- [x] Request `--domain all --no-wait --json`.
- [x] Verify the token with `auth status --json --verify`.
- [x] Compare every application user scope with the granted user scope set.
- [x] Check message, document, Base, calendar, and Drive capabilities.
- [x] Persist only authorization mode, scope version, CLI version, and authorization time.
- [x] Keep QR data, authorization URL, and device code in memory.
- [x] Install and verify the complete official Feishu Skills set, including `lark-base`.
- [x] Verify the first-install and QR states in the real Obsidian runtime.

**Follow-up Polish**

- Run the final mobile scan and connected-account capture when a disposable Feishu account is available for end-to-end acceptance.
- Recheck the same states on Windows and Linux when automatic managed installation is enabled there.

final result: passed
