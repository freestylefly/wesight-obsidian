import { App, Modal, Notice, Setting } from 'obsidian';

import { RuntimeDiscovery } from '../runtime/discovery';
import type { WeSightObsidianSettings } from '../types';
import { mergeEnvironment } from '../utils/env';
import { RuntimeSetupModal } from './runtimeSetupModal';
import {
  checkAntigravityAuth,
  startAntigravityLogin,
  type AntigravityLoginSession,
} from '../runtime/antigravity';

/**
 * Browser sign-in for Antigravity: open Google in the browser, then paste the code
 * the Antigravity callback page shows. The code goes to `agy acp --login` via stdin.
 */
export class AntigravityLoginModal extends Modal {
  private session: AntigravityLoginSession | null = null;
  private finished = false;

  constructor(
    app: App,
    private readonly binaryPath: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly onSignedIn: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('wesight-antigravity-login');
    contentEl.createEl('h2', { text: '登录 Antigravity' });
    contentEl.createEl('p', {
      text: '1. 点击「打开浏览器登录」，用 Google 账号完成授权。\n2. 授权完成后，页面会显示一个授权码，复制后粘贴到下面并提交。',
      cls: 'wesight-antigravity-steps',
    });
    const statusEl = contentEl.createDiv({ cls: 'wesight-antigravity-status', text: '正在启动 Antigravity 登录…' });

    let authUrl = '';
    let codeValue = '';
    let submitting = false;

    const linkSetting = new Setting(contentEl)
      .setName('登录链接')
      .setDesc('等待 Antigravity 返回链接…');
    let openButton: { setDisabled(disabled: boolean): unknown } | null = null;
    linkSetting.addButton(button => {
      openButton = button;
      button.setButtonText('打开浏览器登录').setCta().setDisabled(true).onClick(() => {
        if (authUrl) window.open(authUrl, '_blank', 'noopener,noreferrer');
      });
    });
    linkSetting.addButton(button => button.setButtonText('复制链接').onClick(async () => {
      if (!authUrl) return;
      try {
        await navigator.clipboard.writeText(authUrl);
        new Notice('登录链接已复制。');
      } catch {
        new Notice('复制失败，请直接点击「打开浏览器登录」。');
      }
    }));

    let submitButton: { setDisabled(disabled: boolean): unknown; setButtonText(text: string): unknown } | null = null;
    new Setting(contentEl)
      .setName('授权码')
      .setDesc('粘贴 antigravity.google 页面上显示的授权码。')
      .addText(text => {
        text.setPlaceholder('粘贴授权码').onChange(value => { codeValue = value; });
        text.inputEl.addClass('wesight-antigravity-code-input');
        text.inputEl.addEventListener('keydown', event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        });
      })
      .addButton(button => {
        submitButton = button;
        button.setButtonText('提交').setCta().setDisabled(true).onClick(() => submit());
      });

    new Setting(contentEl).addButton(button => button.setButtonText('取消').onClick(() => this.close()));

    const submit = (): void => {
      if (!this.session || submitting) return;
      try {
        this.session.submit(codeValue);
      } catch (error) {
        statusEl.setText(error instanceof Error ? error.message : String(error));
        return;
      }
      submitting = true;
      submitButton?.setDisabled(true);
      submitButton?.setButtonText('验证中…');
      statusEl.setText('正在验证授权码…');
    };

    let session: AntigravityLoginSession;
    try {
      session = startAntigravityLogin(this.binaryPath, this.env);
    } catch (error) {
      statusEl.setText(`无法启动登录：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.session = session;

    session.authorizationUrl.then(url => {
      authUrl = url;
      linkSetting.setDesc('链接已就绪。');
      openButton?.setDisabled(false);
      submitButton?.setDisabled(false);
      statusEl.setText('请在浏览器中完成 Google 授权，然后粘贴授权码。');
      window.open(url, '_blank', 'noopener,noreferrer');
    }, (error: unknown) => {
      statusEl.setText(error instanceof Error ? error.message : String(error));
    });

    session.completed.then(async () => {
      this.finished = true;
      statusEl.setText('登录成功，正在读取可用模型…');
      await checkAntigravityAuth(this.binaryPath, this.env, { force: true });
      new Notice('Antigravity 登录成功。');
      this.onSignedIn();
      this.close();
    }, (error: unknown) => {
      if (this.finished) return;
      this.finished = true;
      submitting = false;
      statusEl.setText(error instanceof Error ? error.message : String(error));
      submitButton?.setDisabled(true);
      submitButton?.setButtonText('提交');
      const retry = statusEl.createEl('button', { text: '重新开始', cls: 'mod-cta wesight-antigravity-retry' });
      retry.onclick = () => {
        this.finished = false;
        this.onOpen();
      };
    });
  }

  override onClose(): void {
    if (!this.finished) this.session?.cancel();
    this.session = null;
    this.contentEl.empty();
  }
}

export function antigravityEnvironment(settings: WeSightObsidianSettings): NodeJS.ProcessEnv {
  return mergeEnvironment(process.env, settings.sharedEnvironmentVariables);
}

export function resolveAntigravityBinary(settings: WeSightObsidianSettings): string | null {
  return new RuntimeDiscovery({
    configuredPaths: settings.configuredPaths,
    configSources: settings.configSources,
  }).resolve('antigravity').binaryPath;
}

/** Checks the local Antigravity CLI first; only then starts the browser sign-in. */
export function openAntigravityLogin(
  app: App,
  settings: WeSightObsidianSettings,
  openSettings: () => void,
  onSignedIn: () => void,
): void {
  const status = new RuntimeDiscovery({
    configuredPaths: settings.configuredPaths,
    configSources: settings.configSources,
  }).resolve('antigravity');
  if (!status.binaryPath) {
    new RuntimeSetupModal(app, status, openSettings).open();
    return;
  }
  new AntigravityLoginModal(app, status.binaryPath, antigravityEnvironment(settings), onSignedIn).open();
}
