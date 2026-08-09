import { App, Modal, setIcon } from 'obsidian';

import type { CloudAuthService } from '../share/cloudAuth';
import type { KnowledgeBrainAccessStatus } from './types';

function titleFor(access: KnowledgeBrainAccessStatus): string {
  if (access.state === 'login-required') return '登录后开启知识大脑';
  if (access.state === 'expired') return '续费会员后继续使用';
  if (access.state === 'membership-required') return '会员内测功能';
  if (access.state === 'beta-paused') return '知识大脑内测暂未开放';
  return '正在验证会员资格';
}

export class KnowledgeBrainAccessModal extends Modal {
  constructor(
    app: App,
    private readonly auth: CloudAuthService,
    private readonly access: KnowledgeBrainAccessStatus,
    private readonly retry?: () => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('wesight-kb-access-modal');
    const icon = this.contentEl.createDiv({ cls: 'wesight-kb-access-icon' });
    setIcon(icon, 'lock-keyhole');
    this.contentEl.createEl('h2', { text: titleFor(this.access) });
    this.contentEl.createEl('p', {
      text: this.access.reason || '知识大脑内测仅向 WeSight 有效会员开放。',
    });
    this.contentEl.createEl('p', {
      cls: 'wesight-kb-access-note',
      text: '知识大脑不消耗积分，笔记和知识库内容继续保存在本地。',
    });
    const actions = this.contentEl.createDiv({ cls: 'wesight-kb-access-actions' });
    const close = actions.createEl('button', { text: '稍后再说' });
    close.onclick = () => this.close();
    if (this.access.state === 'login-required') {
      const login = actions.createEl('button', { cls: 'mod-cta', text: '登录 WeSight' });
      login.onclick = () => {
        this.auth.startLogin();
        this.close();
      };
      return;
    }
    if (this.access.state === 'membership-required' || this.access.state === 'expired') {
      const billing = actions.createEl('button', {
        cls: 'mod-cta',
        text: this.access.state === 'expired' ? '续费会员' : '开通会员',
      });
      billing.onclick = () => {
        this.auth.openBilling();
        this.close();
      };
      return;
    }
    if (this.retry) {
      const retry = actions.createEl('button', { cls: 'mod-cta', text: '重新检查' });
      retry.onclick = async () => {
        retry.disabled = true;
        await this.retry?.();
        this.close();
      };
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
