import { App, Modal } from 'obsidian';

import { normalizeWeChatArticleUrl } from '../wechat/frontmatter';

export interface WeChatArticleLinkPromptOptions {
  initialValue?: string;
}

export function promptForWeChatArticleLink(
  app: App,
  options: WeChatArticleLinkPromptOptions = {},
): Promise<string | null> {
  return new Promise(resolve => {
    new WeChatArticleLinkModal(app, options, resolve).open();
  });
}

class WeChatArticleLinkModal extends Modal {
  private submitted = false;
  private normalizedUrl: string | null = null;

  constructor(
    app: App,
    private readonly options: WeChatArticleLinkPromptOptions,
    private readonly resolve: (url: string | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('wesight-wechat-article-link-modal');
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', {
      text: this.options.initialValue ? '更换发布链接' : '添加发布链接',
    });
    contentEl.createEl('p', {
      cls: 'wesight-wechat-article-link-modal-description',
      text: '绑定后将自动同步这篇文章的公开数据。',
    });

    const field = contentEl.createDiv({ cls: 'wesight-wechat-article-link-field' });
    const inputId = `wesight-wechat-article-link-${Date.now()}`;
    field.createEl('label', {
      text: '公众号文章链接',
      attr: { for: inputId },
    });
    const input = field.createEl('input', {
      attr: {
        id: inputId,
        type: 'url',
        inputmode: 'url',
        placeholder: '粘贴 mp.weixin.qq.com 文章链接',
      },
    });
    input.value = this.options.initialValue ?? '';
    field.createEl('p', {
      cls: 'wesight-wechat-article-link-help',
      text: '请先在公众号后台发布文章，再粘贴文章链接。',
    });
    const error = field.createEl('p', {
      cls: 'wesight-wechat-article-link-error',
      attr: { role: 'alert', 'aria-live': 'polite' },
    });

    const actions = contentEl.createDiv({ cls: 'wesight-wechat-article-link-actions' });
    const cancel = actions.createEl('button', {
      text: '取消',
      attr: { type: 'button' },
    });
    cancel.onclick = () => this.close();
    const submit = actions.createEl('button', {
      cls: 'mod-cta',
      text: '绑定并同步',
      attr: { type: 'button' },
    });

    const handleSubmit = (): void => {
      const normalized = normalizeWeChatArticleUrl(input.value);
      if (!normalized) {
        error.setText(input.value.trim()
          ? '请输入有效的公众号文章链接。'
          : '请粘贴公众号文章链接。');
        input.focus();
        return;
      }
      this.normalizedUrl = normalized;
      this.submitted = true;
      this.close();
    };
    submit.onclick = handleSubmit;
    input.addEventListener('input', () => error.empty());
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      handleSubmit();
    });

    window.setTimeout(() => {
      input.focus();
      if (input.value) input.select();
    }, 0);
  }

  override onClose(): void {
    this.contentEl.empty();
    this.resolve(this.submitted ? this.normalizedUrl : null);
  }
}
