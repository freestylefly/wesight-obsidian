import { App, Modal, Notice, Setting } from 'obsidian';

import type { WeChatCustomThemePreferences } from '../wechat/themes';

export function promptForCustomWeChatTheme(
  app: App,
  initial: WeChatCustomThemePreferences,
): Promise<WeChatCustomThemePreferences | null> {
  return new Promise(resolve => {
    new WeChatCustomThemeModal(app, initial, resolve).open();
  });
}

class WeChatCustomThemeModal extends Modal {
  private name: string;
  private description: string;
  private submitted = false;

  constructor(
    app: App,
    initial: WeChatCustomThemePreferences,
    private readonly resolve: (value: WeChatCustomThemePreferences | null) => void,
  ) {
    super(app);
    this.name = initial.name;
    this.description = initial.description;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('wesight-wechat-custom-theme-modal');
    contentEl.createEl('h2', { text: 'AI自定义主题' });
    contentEl.createEl('p', {
      cls: 'wesight-wechat-custom-theme-intro',
      text: '描述你想要的公众号排版风格，WeSight 会使用当前配置的代理引擎、服务商和模型生成预览。主题描述会保存在本机，后续文章可继续使用。',
    });

    new Setting(contentEl)
      .setName('主题名称')
      .setDesc('可选，用于主题按钮和生成状态展示')
      .addText(text => text
        .setPlaceholder('例如：雾蓝科技刊')
        .setValue(this.name)
        .onChange(value => {
          this.name = value;
        }));

    const descriptionSetting = new Setting(contentEl)
      .setName('主题描述')
      .setDesc('必填。可以写气质、配色、字体、圆角、阴影和适用场景，也可以说明不希望出现的元素。');
    descriptionSetting.settingEl.addClass('wesight-wechat-custom-theme-description-setting');
    descriptionSetting.addTextArea(text => {
      text
        .setPlaceholder('例如：浅色科技杂志风，雾蓝色点缀，大留白，标题克制，正文清晰，卡片使用小圆角和轻阴影，适合 AI 产品深度评测。')
        .setValue(this.description)
        .onChange(value => {
          this.description = value;
        });
      text.inputEl.rows = 7;
    });

    const actions = new Setting(contentEl);
    actions.settingEl.addClass('wesight-wechat-custom-theme-actions');
    actions
      .addButton(button => button
        .setButtonText('取消')
        .onClick(() => this.close()))
      .addButton(button => button
        .setButtonText('生成主题')
        .setCta()
        .onClick(() => this.submit()));
  }

  private submit(): void {
    if (!this.description.trim()) {
      new Notice('请先填写主题描述。');
      return;
    }
    this.name = this.name.trim() || 'AI自定义主题';
    this.description = this.description.trim();
    this.submitted = true;
    this.close();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.resolve(this.submitted ? {
      name: this.name,
      description: this.description,
    } : null);
  }
}
