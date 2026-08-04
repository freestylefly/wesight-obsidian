import { App, Modal, Notice, setIcon } from 'obsidian';

import type { CloudAuthService } from '../share/cloudAuth';
import type { CloudBillingSummary } from '../share/types';

function expiry(value: string | null): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}

class BillingModal extends Modal {
  private pollTimer: number | null = null;
  private refreshing = false;

  constructor(
    app: App,
    private readonly auth: CloudAuthService,
    private summary: CloudBillingSummary,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('wesight-billing-modal');
    this.render();
  }

  override onClose(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.contentEl.empty();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    const icon = root.createDiv({ cls: 'wesight-billing-modal-icon' });
    setIcon(icon, 'gem');
    root.createEl('h2', { text: '会员与积分' });
    root.createEl('p', {
      cls: 'wesight-billing-modal-lead',
      text: this.summary.totalCreditsRemaining > 0
        ? `当前剩余 ${this.summary.totalCreditsRemaining} 积分，每次成功同步公众号草稿消耗 1 积分。`
        : '当前积分不足，充值积分或开通创作者会员后即可继续发文章。',
    });

    const balances = root.createDiv({ cls: 'wesight-billing-balance-grid' });
    this.balanceCard(balances, '可用积分', this.summary.totalCreditsRemaining);
    this.balanceCard(balances, '会员积分', this.summary.balances.membership);
    this.balanceCard(balances, '永久积分', this.summary.balances.purchased);
    if (this.summary.membership.active) {
      root.createDiv({
        cls: 'wesight-billing-membership-state',
        text: `创作者会员 · 有效至 ${expiry(this.summary.membership.expiresAt)}`,
      });
    }

    const hints = root.createDiv({ cls: 'wesight-billing-hints' });
    hints.createDiv({ text: '积分包永久有效' });
    hints.createDiv({ text: '月卡 ¥15.9 含 100 积分' });
    hints.createDiv({ text: '年卡 ¥128 含 1200 积分' });

    const state = root.createDiv({ cls: 'wesight-billing-refresh-state' });
    state.setText(this.pollTimer === null ? '支付完成后，积分会自动更新。' : '正在等待支付到账…');
    const actions = root.createDiv({ cls: 'wesight-billing-modal-actions' });
    const cancel = actions.createEl('button', { text: '稍后再说' });
    cancel.onclick = () => this.close();
    const recharge = actions.createEl('button', {
      cls: 'mod-cta',
      text: '去充值',
    });
    recharge.onclick = () => {
      this.auth.openBilling();
      this.startPolling();
      this.render();
    };
  }

  private balanceCard(parent: HTMLElement, label: string, value: number): void {
    const card = parent.createDiv();
    card.createSpan({ text: label });
    card.createEl('strong', { text: String(value) });
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    const previousBalance = this.summary.totalCreditsRemaining;
    const previousExpiry = this.summary.membership.expiresAt;
    this.pollTimer = window.setInterval(() => {
      if (this.refreshing) return;
      this.refreshing = true;
      void this.auth.refreshBillingSummary(false)
        .then((summary) => {
          this.summary = summary;
          const changed = summary.totalCreditsRemaining > previousBalance
            || summary.membership.expiresAt !== previousExpiry;
          if (changed) {
            this.auth.notifyChanged();
            new Notice(`支付成功，当前剩余 ${summary.totalCreditsRemaining} 积分。`);
            this.close();
            return;
          }
          this.render();
        })
        .catch(() => undefined)
        .finally(() => { this.refreshing = false; });
    }, 3000);
  }
}

export function openBillingModal(
  app: App,
  auth: CloudAuthService,
  summary: CloudBillingSummary,
): void {
  new BillingModal(app, auth, summary).open();
}
