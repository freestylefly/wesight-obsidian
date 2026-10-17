import { App, Notice, setIcon } from 'obsidian';

import wesightLogo from '../../assets/wesight-logo.png';
import {
  buildJikePostText,
  clampJikeCircle,
  clampJikePostBody,
  createInitialJikePostCopy,
  JIKE_POST_BODY_LIMIT,
  JIKE_POST_TOPICS_CHAR_LIMIT,
  jikePostPreview,
  normalizeJikeTopics,
} from '../jikePost/copy';
import {
  buildJikePostPublishSnapshot,
  JIKE_POST_MAX_IMAGES,
  validateJikePostPublishInput,
} from '../jikePost/publish';
import type { JikePostDraftStore } from '../jikePost/store';
import type {
  JikePostCopyDraft,
  JikePostDraftRecord,
  JikePostImage,
  JikePostTone,
} from '../jikePost/types';
import type { MultiPublishBridge } from '../multiPublish/bridge';
import { requireBrowserConnection } from '../multiPublish/connection';
import type { MultiPublishSnapshot, MultiPublishTaskState } from '../multiPublish/types';
import {
  quickTransformSourceImages,
  readSnapshotAssetReference,
} from '../quickTransform/images';
import type { CloudAuthService } from '../share/cloudAuth';
import type { VaultStore } from '../storage/vaultStore';
import type { WeSightObsidianSettings } from '../types';
import type { XiaohongshuGenerationService } from '../xiaohongshu/generationService';
import type { XhsGeneratedPage } from '../xiaohongshu/types';
import type { ContentWorkbenchSection } from './weiboPostWorkbench';
import { requireMemberFeature } from './memberFeatureGate';

const JIKE_PUBLISH_STATUS = {
  queued: '等待浏览器扩展',
  opening: '正在打开即刻',
  login_required: '需要登录即刻',
  filling: '正在上传图片并填充动态',
  ready: '内容已准备，请检查后发布',
  failed: '发布准备失败',
  cancelled: '任务已取消',
} as const;

const TONE_OPTIONS: Array<{ id: JikePostTone; label: string; description: string }> = [
  { id: 'opinion', label: '观点分享', description: '一句判断、两个依据、一个开放问题' },
  { id: 'experience', label: '经验记录', description: '从真实体验和具体观察切入' },
  { id: 'casual', label: '轻松随想', description: '更自然、更像即友间聊天' },
];

export interface JikePostWorkbenchOptions {
  app: App;
  getSettings: () => WeSightObsidianSettings;
  auth: CloudAuthService;
  bridge: MultiPublishBridge;
  generationService: XiaohongshuGenerationService;
  draftStore: JikePostDraftStore;
  vaultStore: VaultStore;
  getXiaohongshuImages: () => XhsGeneratedPage[];
  openSettings: () => void;
  openBrowserConnector: () => void;
  showSection: (section: ContentWorkbenchSection) => void;
  requestRender: () => void;
}

export class JikePostWorkbench {
  private snapshot: MultiPublishSnapshot | null = null;
  private copy: JikePostCopyDraft = {
    body: '',
    topics: [],
    tone: 'opinion',
    circle: 'AI 探索站',
  };
  private customPrompt = '';
  private images: JikePostImage[] = [];
  private operation: 'copy' | 'upload' | null = null;
  private publishTask: MultiPublishTaskState | null = null;
  private publishBusy = false;
  private publishLoginPending = false;
  private error = '';
  private saveTimer: number | null = null;
  private generationController: AbortController | null = null;
  private lifecycleVersion = 0;

  constructor(private readonly options: JikePostWorkbenchOptions) {}

  async load(snapshot: MultiPublishSnapshot, preserveEdits = false): Promise<void> {
    const preserveCurrent = preserveEdits && this.snapshot?.sourcePath === snapshot.sourcePath;
    await this.save();
    this.snapshot = snapshot;
    if (preserveCurrent) {
      await this.save();
      return;
    }
    const saved = await this.options.draftStore.load(snapshot.contentHash);
    this.copy = saved?.copy ?? createInitialJikePostCopy(snapshot);
    this.customPrompt = saved?.customPrompt ?? '';
    this.images = saved?.images?.filter(image => image.vaultPath).slice(0, JIKE_POST_MAX_IMAGES)
      ?? this.articleImages().slice(0, JIKE_POST_MAX_IMAGES);
    this.publishTask = null;
    this.publishLoginPending = false;
    this.error = '';
    if (!saved) void this.save();
  }

  reset(): void {
    this.snapshot = null;
    this.copy = { body: '', topics: [], tone: 'opinion', circle: 'AI 探索站' };
    this.customPrompt = '';
    this.images = [];
    this.publishTask = null;
    this.error = '';
    this.generationController?.abort();
  }

  dispose(): void {
    this.lifecycleVersion += 1;
    this.generationController?.abort();
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  onAuthChange(): void {
    this.publishLoginPending = false;
  }

  onBridgeChange(): void {
    if (!this.publishTask) return;
    this.publishTask = this.options.bridge.getTask(this.publishTask.taskId) ?? this.publishTask;
  }

  async prepareQuickDraft(images: JikePostImage[], signal: AbortSignal): Promise<void> {
    if (!this.snapshot) throw new Error('即刻工作台还没有读取当前文章');
    const copy = await this.options.generationService.generateJikePostCopy(
      this.snapshot,
      this.copy.tone,
      this.customPrompt,
      signal,
    );
    if (signal.aborted) throw new DOMException('已停止生成', 'AbortError');
    this.copy = copy;
    this.images = images.slice(0, JIKE_POST_MAX_IMAGES);
    this.error = '';
    await this.save();
  }

  getQuickCopy(): JikePostCopyDraft {
    return { ...this.copy, topics: [...this.copy.topics] };
  }

  getQuickImageCount(): number {
    return this.images.length;
  }

  async setQuickDraft(copy: JikePostCopyDraft, images: JikePostImage[]): Promise<void> {
    this.copy = {
      ...copy,
      body: clampJikePostBody(copy.body),
      topics: normalizeJikeTopics(copy.topics),
      circle: clampJikeCircle(copy.circle),
    };
    this.images = images.slice(0, JIKE_POST_MAX_IMAGES);
    this.error = '';
    await this.save();
  }

  updateQuickCopy(values: Partial<Pick<JikePostCopyDraft, 'body' | 'topics'>>): void {
    this.copy = {
      ...this.copy,
      ...(values.body === undefined ? {} : { body: clampJikePostBody(values.body) }),
      ...(values.topics === undefined ? {} : { topics: normalizeJikeTopics(values.topics) }),
    };
    this.scheduleSave();
  }

  async buildQuickPublishSnapshot(): Promise<MultiPublishSnapshot> {
    if (!this.snapshot) throw new Error('即刻工作台还没有读取当前文章');
    await this.save();
    return buildJikePostPublishSnapshot({
      source: this.snapshot,
      copy: this.copy,
      images: this.images,
      readBinary: reference => this.readImageBinary(reference),
    });
  }

  setQuickPublishTask(task: MultiPublishTaskState | null): void {
    this.publishTask = task;
  }

  render(parent: HTMLElement, section: ContentWorkbenchSection): void {
    if (!this.snapshot) return;
    if (this.error) this.renderError(parent);
    if (section === 'copy') this.renderCopy(parent);
    if (section === 'images') this.renderImages(parent);
    if (section === 'review') this.renderReview(parent);
  }

  private renderCopy(parent: HTMLElement): void {
    const layout = parent.createDiv({ cls: 'wesight-jike-copy-layout' });
    const canvas = layout.createDiv({ cls: 'wesight-jike-copy-canvas' });

    const heading = canvas.createDiv({ cls: 'wesight-jike-copy-heading' });
    const headingCopy = heading.createDiv();
    headingCopy.createEl('strong', { text: '写一条值得讨论的动态' });
    headingCopy.createSpan({ text: '即刻更适合鲜明观点、真实经验和一个能继续聊下去的问题' });
    const engine = heading.createDiv({ cls: 'wesight-jike-engine-control' });
    engine.createEl('strong', { text: engineLabel(this.options.getSettings().defaultAgentId) });
    const engineChevron = engine.createSpan({ cls: 'wesight-jike-engine-chevron' });
    setIcon(engineChevron, 'chevron-down');
    const changeEngine = engine.createEl('button', { text: '更换引擎', attr: { type: 'button' } });
    changeEngine.onclick = () => this.options.openSettings();

    const recommendation = canvas.createDiv({ cls: 'wesight-jike-structure' });
    recommendation.createEl('strong', { text: '推荐结构' });
    recommendation.createSpan({ text: '一句判断 · 两个依据 · 一个开放问题' });
    const apply = recommendation.createEl('button', { text: '应用', attr: { type: 'button' } });
    apply.onclick = () => {
      const instruction = '请使用一句判断、两个依据、一个开放问题的结构。';
      if (!this.customPrompt.includes(instruction)) {
        this.customPrompt = [this.customPrompt.trim(), instruction].filter(Boolean).join('\n');
        this.scheduleSave();
      }
      new Notice('已应用推荐结构，下次生成会按这个结构改写。');
      this.options.requestRender();
    };

    const bodyField = canvas.createDiv({ cls: 'wesight-xhs-field wesight-jike-body-field' });
    const bodyLabel = bodyField.createDiv({ cls: 'wesight-xhs-field-label' });
    bodyLabel.createEl('label', { text: '动态正文' });
    const counter = bodyLabel.createSpan({ text: `${Array.from(this.copy.body).length}/${JIKE_POST_BODY_LIMIT}` });
    const body = bodyField.createEl('textarea', {
      attr: {
        rows: '13',
        maxlength: String(JIKE_POST_BODY_LIMIT),
        placeholder: '输入适合即刻社区讨论的动态正文',
      },
    });
    body.value = this.copy.body;
    body.oninput = () => {
      this.copy.body = clampJikePostBody(body.value);
      if (body.value !== this.copy.body) body.value = this.copy.body;
      counter.setText(`${Array.from(this.copy.body).length}/${JIKE_POST_BODY_LIMIT}`);
      this.scheduleSave();
      this.refreshFeedPreview();
    };

    const generation = canvas.createDiv({ cls: 'wesight-jike-generation-row' });
    const tones = generation.createDiv({ cls: 'wesight-jike-tone-list' });
    for (const tone of TONE_OPTIONS) {
      const button = tones.createEl('button', {
        cls: this.copy.tone === tone.id ? 'is-selected' : '',
        text: tone.label,
        attr: { type: 'button', title: tone.description },
      });
      button.onclick = () => {
        this.copy.tone = tone.id;
        this.scheduleSave();
        this.options.requestRender();
      };
    }
    const promptSettings = generation.createEl('details', { cls: 'wesight-jike-prompt-settings' });
    promptSettings.createEl('summary', { text: '自定义要求' });
    const prompt = promptSettings.createEl('textarea', {
      attr: { rows: '3', placeholder: '例如：保留技术细节，语气更克制。' },
    });
    prompt.value = this.customPrompt;
    prompt.oninput = () => {
      this.customPrompt = prompt.value;
      this.scheduleSave();
    };
    const generate = generation.createEl('button', {
      cls: 'wesight-xhs-primary-button wesight-jike-generate-button',
      text: this.operation === 'copy' ? '正在生成…' : 'AI 重新生成',
      attr: { type: 'button' },
    });
    const generateIcon = generate.createSpan();
    setIcon(generateIcon, this.operation === 'copy' ? 'loader-circle' : 'sparkles');
    generate.prepend(generateIcon);
    generate.disabled = Boolean(this.operation);
    generate.onclick = () => void this.generateCopy();

    const destination = canvas.createDiv({ cls: 'wesight-jike-destination' });
    const circleRow = destination.createDiv({ cls: 'wesight-jike-destination-row' });
    circleRow.createEl('strong', { text: '发布到' });
    const circleControl = circleRow.createDiv({ cls: 'wesight-jike-circle-control' });
    const circleIcon = circleControl.createSpan();
    setIcon(circleIcon, 'circle-dot');
    const circle = circleControl.createEl('input', {
      attr: {
        type: 'text',
        value: this.copy.circle,
        maxlength: '30',
        'aria-label': '即刻圈子',
      },
    });
    circle.oninput = () => {
      this.copy.circle = clampJikeCircle(circle.value);
      if (circle.value !== this.copy.circle) circle.value = this.copy.circle;
      this.scheduleSave();
      this.refreshCirclePreview();
    };
    const topicsRow = destination.createDiv({ cls: 'wesight-jike-destination-row' });
    const topicLabel = topicsRow.createDiv({ cls: 'wesight-jike-topic-label' });
    topicLabel.createEl('strong', { text: '加入话题' });
    const renderedTopicLength = Array.from(this.copy.topics.map(topic => `#${topic}#`).join(' ')).length;
    topicLabel.createSpan({ text: `${renderedTopicLength}/${JIKE_POST_TOPICS_CHAR_LIMIT}` });
    const topicList = topicsRow.createDiv({ cls: 'wesight-xhs-tags wesight-jike-topic-list' });
    for (const topic of this.copy.topics) {
      const chip = topicList.createSpan({ cls: 'wesight-xhs-tag' });
      chip.createSpan({ text: `#${topic}` });
      const remove = chip.createEl('button', { attr: { type: 'button', 'aria-label': `删除话题 ${topic}` } });
      setIcon(remove, 'x');
      remove.onclick = () => {
        this.copy.topics = this.copy.topics.filter(value => value !== topic);
        this.scheduleSave();
        this.options.requestRender();
      };
    }
    const topicInput = topicList.createEl('input', {
      cls: 'wesight-xhs-tag-input',
      attr: { type: 'text', placeholder: '输入话题后回车', maxlength: '20' },
    });
    topicInput.onkeydown = event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.copy.topics = normalizeJikeTopics([...this.copy.topics, topicInput.value]);
      this.scheduleSave();
      this.options.requestRender();
    };

    const preview = layout.createDiv({ cls: 'wesight-jike-preview-rail' });
    preview.createEl('strong', { text: '即刻预览' });
    const card = preview.createDiv({ cls: 'wesight-jike-feed-card' });
    const account = card.createDiv({ cls: 'wesight-jike-feed-account' });
    account.createEl('img', {
      cls: 'wesight-jike-feed-avatar',
      attr: { src: wesightLogo, alt: '苍何' },
    });
    const accountCopy = account.createDiv();
    accountCopy.createEl('strong', { text: '苍何' });
    accountCopy.createSpan({ cls: 'wesight-jike-circle-preview', text: this.copy.circle || '待选择圈子' });
    accountCopy.createSpan({ text: '刚刚 · 来自 WeSight' });
    card.createEl('p', {
      cls: 'wesight-jike-feed-body',
      text: jikePostPreview(this.copy.body) || '生成或输入文案后，这里会显示即刻信息流效果。',
    });
    const feedImages = card.createDiv({ cls: 'wesight-jike-feed-images' });
    this.images.slice(0, 4).forEach(image => feedImages.createEl('img', {
      attr: { src: this.imageResourceUrl(image), alt: image.label },
    }));
    const metrics = card.createDiv({ cls: 'wesight-jike-feed-metrics' });
    [
      { label: '转发', icon: 'repeat-2' },
      { label: '评论', icon: 'message-square' },
      { label: '赞', icon: 'thumbs-up' },
    ].forEach(item => {
      const metric = metrics.createSpan();
      const icon = metric.createSpan();
      setIcon(icon, item.icon);
      metric.createSpan({ text: item.label });
    });

    const next = parent.createDiv({ cls: 'wesight-jike-section-footer is-copy' });
    const nextButton = next.createEl('button', {
      cls: 'wesight-xhs-primary-button',
      text: '下一步：选择配图',
      attr: { type: 'button' },
    });
    const nextIcon = nextButton.createSpan();
    setIcon(nextIcon, 'arrow-right');
    nextButton.append(nextIcon);
    nextButton.onclick = () => this.options.showSection('images');
  }

  private renderImages(parent: HTMLElement): void {
    const heading = parent.createDiv({ cls: 'wesight-xhs-copy-toolbar' });
    const copy = heading.createDiv();
    copy.createEl('strong', { text: `即刻配图（${this.images.length}/${JIKE_POST_MAX_IMAGES}）` });
    copy.createSpan({ text: '按当前顺序展示，可发布纯文字动态，也可加入 1–9 张图片。' });
    const actions = heading.createDiv({ cls: 'wesight-weibo-image-actions' });
    const upload = actions.createEl('button', {
      cls: 'wesight-xhs-subtle-button',
      text: this.operation === 'upload' ? '正在导入…' : '添加本地图片',
      attr: { type: 'button' },
    });
    const uploadIcon = upload.createSpan();
    setIcon(uploadIcon, 'image-plus');
    upload.prepend(uploadIcon);
    upload.disabled = Boolean(this.operation) || this.images.length >= JIKE_POST_MAX_IMAGES;
    upload.onclick = () => void this.pickLocalImages();

    const xhsImages = this.xiaohongshuImages().filter(image => !this.images.some(item => item.id === image.id));
    if (xhsImages.length) {
      const importXhs = actions.createEl('button', {
        cls: 'wesight-xhs-subtle-button',
        text: '导入小红书配图',
        attr: { type: 'button' },
      });
      importXhs.onclick = () => {
        const remaining = JIKE_POST_MAX_IMAGES - this.images.length;
        this.images.push(...xhsImages.slice(0, remaining));
        this.scheduleSave();
        this.options.requestRender();
      };
    }

    if (!this.images.length) {
      const empty = parent.createDiv({ cls: 'wesight-xhs-review-empty' });
      empty.createEl('strong', { text: '当前是纯文字动态' });
      empty.createSpan({ text: '可从文章图片、小红书生成图或本地图片中选择最多 9 张。' });
    } else {
      const selected = parent.createDiv({ cls: 'wesight-weibo-selected-grid' });
      this.images.forEach((image, index) => {
        const card = selected.createDiv({ cls: 'wesight-weibo-image-card is-selected' });
        card.createEl('img', {
          attr: { src: this.imageResourceUrl(image), alt: image.label },
        });
        card.createSpan({ cls: 'wesight-weibo-image-order', text: String(index + 1) });
        const cardActions = card.createDiv({ cls: 'wesight-weibo-image-card-actions' });
        const previous = cardActions.createEl('button', { attr: { type: 'button', 'aria-label': '前移' } });
        setIcon(previous, 'chevron-left');
        previous.disabled = index === 0;
        previous.onclick = () => this.moveImage(index, index - 1);
        const next = cardActions.createEl('button', { attr: { type: 'button', 'aria-label': '后移' } });
        setIcon(next, 'chevron-right');
        next.disabled = index === this.images.length - 1;
        next.onclick = () => this.moveImage(index, index + 1);
        const remove = cardActions.createEl('button', { attr: { type: 'button', 'aria-label': '移除图片' } });
        setIcon(remove, 'x');
        remove.onclick = () => {
          this.images.splice(index, 1);
          this.scheduleSave();
          this.options.requestRender();
        };
      });
    }

    const available = this.availableImages().filter(image => !this.images.some(selected => selected.id === image.id));
    if (available.length) {
      const library = parent.createDiv({ cls: 'wesight-weibo-library' });
      library.createEl('strong', { text: '可用素材' });
      library.createSpan({ text: '点击加入当前即刻动态，最多 9 张。' });
      const grid = library.createDiv({ cls: 'wesight-weibo-library-grid' });
      for (const image of available) {
        const button = grid.createEl('button', {
          cls: 'wesight-weibo-library-item',
          attr: { type: 'button', title: image.label },
        });
        button.createEl('img', {
          attr: { src: this.imageResourceUrl(image), alt: image.label },
        });
        button.createSpan({ text: image.source === 'article' ? '原文' : '小红书' });
        button.disabled = this.images.length >= JIKE_POST_MAX_IMAGES;
        button.onclick = () => {
          if (this.images.length >= JIKE_POST_MAX_IMAGES) return;
          this.images.push(image);
          this.scheduleSave();
          this.options.requestRender();
        };
      }
    }

    const footer = parent.createDiv({ cls: 'wesight-weibo-section-footer' });
    footer.createSpan({ text: '支持 PNG、JPEG、WebP；单图最大 10 MB。' });
    const next = footer.createEl('button', {
      cls: 'wesight-xhs-primary-button',
      text: '下一步：检查内容',
      attr: { type: 'button' },
    });
    const icon = next.createSpan();
    setIcon(icon, 'arrow-right');
    next.append(icon);
    next.onclick = () => this.options.showSection('review');
  }

  private renderReview(parent: HTMLElement): void {
    const summary = parent.createDiv({ cls: 'wesight-xhs-review-summary wesight-weibo-review-summary' });
    const copy = summary.createDiv({ cls: 'wesight-xhs-review-copy' });
    const heading = copy.createDiv({ cls: 'wesight-xhs-section-heading' });
    heading.createEl('strong', { text: '即刻动态检查' });
    const edit = heading.createEl('button', {
      cls: 'wesight-xhs-subtle-button',
      text: '返回编辑',
      attr: { type: 'button' },
    });
    edit.onclick = () => this.options.showSection('copy');
    const circle = copy.createDiv({ cls: 'wesight-jike-review-circle' });
    const circleIcon = circle.createSpan();
    setIcon(circleIcon, 'circle-dot');
    circle.createSpan({ text: this.copy.circle || '未选择圈子' });
    copy.createEl('p', { cls: 'wesight-xhs-review-body', text: this.copy.body || '未填写即刻动态正文' });
    const topics = copy.createDiv({ cls: 'wesight-xhs-tags' });
    this.copy.topics.forEach(topic => topics.createSpan({ cls: 'wesight-xhs-tag', text: `#${topic}` }));
    const copyButton = copy.createEl('button', {
      cls: 'wesight-xhs-secondary-button',
      text: '复制完整动态',
      attr: { type: 'button' },
    });
    const copyIcon = copyButton.createSpan();
    setIcon(copyIcon, 'copy');
    copyButton.prepend(copyIcon);
    copyButton.onclick = () => void this.copyFullDraft();

    const images = summary.createDiv({ cls: 'wesight-xhs-review-images' });
    const imageHeading = images.createDiv({ cls: 'wesight-xhs-section-heading' });
    imageHeading.createEl('strong', { text: `配图检查（${this.images.length}/${JIKE_POST_MAX_IMAGES}）` });
    const editImages = imageHeading.createEl('button', {
      cls: 'wesight-xhs-subtle-button',
      text: '调整图片',
      attr: { type: 'button' },
    });
    editImages.onclick = () => this.options.showSection('images');
    if (!this.images.length) {
      const empty = images.createDiv({ cls: 'wesight-xhs-review-empty is-compact' });
      empty.createSpan({ text: '将以纯文字动态发布' });
    } else {
      const grid = images.createDiv({ cls: 'wesight-xhs-review-grid' });
      this.images.forEach((image, index) => {
        const item = grid.createEl('a', {
          attr: {
            href: this.imageResourceUrl(image),
            target: '_blank',
            rel: 'noopener',
            title: `打开第 ${index + 1} 张`,
          },
        });
        item.createEl('img', {
          attr: { src: this.imageResourceUrl(image), alt: image.label },
        });
        item.createSpan({ text: `${index + 1}. 配图` });
      });
    }
    this.renderPublish(parent);
  }

  private renderPublish(parent: HTMLElement): void {
    const validationErrors = validateJikePostPublishInput(this.copy, this.images);
    if (validationErrors.length) {
      const preflight = parent.createDiv({ cls: 'wesight-xhs-publish-preflight' });
      const icon = preflight.createSpan();
      setIcon(icon, 'triangle-alert');
      const copy = preflight.createDiv();
      copy.createEl('strong', { text: '发布前还需要处理' });
      validationErrors.slice(0, 3).forEach(message => copy.createSpan({ text: message }));
    }

    if (!this.options.auth.getCurrentUser()) {
      const gate = parent.createDiv({ cls: 'wesight-xhs-publish-card' });
      const heading = gate.createDiv({ cls: 'wesight-xhs-publish-card-heading' });
      const icon = heading.createSpan();
      setIcon(icon, 'log-in');
      const copy = heading.createDiv();
      copy.createEl('strong', { text: '登录后使用即刻发布助手' });
      copy.createSpan({ text: '即刻发布助手为 WeSight 会员功能，请登录并开通会员后使用。' });
      const login = gate.createEl('button', {
        cls: 'wesight-xhs-primary-button',
        text: this.publishLoginPending ? '等待登录完成' : '请先登录 WeSight',
        attr: { type: 'button' },
      });
      login.disabled = this.publishLoginPending;
      login.onclick = () => {
        this.publishLoginPending = true;
        this.options.auth.startLogin();
        this.options.requestRender();
      };
      return;
    }

    const connection = this.options.bridge.getConnectionState();
    const extensionNeedsUpdate = connection.connected
      && connection.supportedPlatforms !== null
      && !connection.supportedPlatforms.includes('jike-post');
    if (!connection.connected) {
      this.renderInstallGuide(parent);
      return;
    }

    const connectionRow = parent.createDiv({
      cls: `wesight-xhs-publish-connection${connection.connected ? ' is-connected' : ''}${extensionNeedsUpdate ? ' is-outdated' : ''}`,
    });
    const connectionIcon = connectionRow.createSpan();
    setIcon(connectionIcon, extensionNeedsUpdate ? 'circle-alert' : connection.connected ? 'link' : 'radio');
    const connectionCopy = connectionRow.createDiv();
    connectionCopy.createEl('strong', {
      text: extensionNeedsUpdate
        ? '发布助手版本过旧'
        : connection.connected ? '发布助手已连接' : '发布助手已配对，等待连接',
    });
    connectionCopy.createSpan({
      text: extensionNeedsUpdate
        ? '请更新本地扩展后再使用即刻动态'
        : '正文和图片仅通过 127.0.0.1 临时通道传输',
    });
    if (extensionNeedsUpdate) {
      const update = connectionRow.createEl('button', {
        cls: 'wesight-xhs-subtle-button',
        text: '连接设置',
        attr: { type: 'button' },
      });
      update.onclick = () => void this.openChromeExtensions();
    }

    if (this.publishTask) {
      this.renderPublishTask(parent, extensionNeedsUpdate);
      return;
    }

    const footer = parent.createDiv({ cls: 'wesight-xhs-review-footer' });
    const note = footer.createDiv();
    const noteIcon = note.createSpan();
    setIcon(noteIcon, 'folder-check');
    const noteCopy = note.createDiv();
    noteCopy.createEl('strong', { text: '即刻素材已保存在当前仓库' });
    noteCopy.createSpan({ text: '发布助手会填好正文、话题和图片，圈子请在即刻编辑页确认。' });
    const publish = footer.createEl('button', {
      cls: 'wesight-xhs-primary-button',
      text: this.publishBusy ? '正在打开发布助手…' : '使用发布助手发布',
      attr: { type: 'button' },
    });
    const publishIcon = publish.createSpan();
    setIcon(publishIcon, this.publishBusy ? 'loader-circle' : 'send');
    publish.prepend(publishIcon);
    publish.disabled = this.publishBusy || validationErrors.length > 0 || extensionNeedsUpdate;
    publish.onclick = () => void this.startPublish(false);
  }

  private renderInstallGuide(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: 'wesight-multi-install-guide' });
    card.createEl('strong', { text: '连接浏览器发布助手' });
    card.createEl('p', { text: '请在设置 → 连接器中完成安装与连接，当前内容会保留。' });
    const button = card.createEl('button', { text: '前往连接设置', cls: 'wesight-xhs-primary-button', attr: { type: 'button' } });
    button.onclick = this.options.openBrowserConnector;
  }

  private renderPublishTask(parent: HTMLElement, extensionNeedsUpdate: boolean): void {
    if (!this.publishTask) return;
    const state = this.publishTask.platforms['jike-post'];
    const card = parent.createDiv({ cls: `wesight-xhs-publish-task is-${state.status}` });
    const icon = card.createSpan();
    setIcon(icon, state.status === 'ready'
      ? 'circle-check'
      : state.status === 'failed' || state.status === 'login_required' ? 'circle-alert' : 'loader-circle');
    const copy = card.createDiv();
    copy.createEl('strong', {
      text: extensionNeedsUpdate ? '发布助手版本过旧' : JIKE_PUBLISH_STATUS[state.status],
    });
    copy.createSpan({
      text: extensionNeedsUpdate
        ? '请重新加载支持即刻动态的最新扩展'
        : state.message || JIKE_PUBLISH_STATUS[state.status],
    });
    if (state.warnings.length) copy.createSpan({ text: state.warnings[0] });
    const actions = card.createDiv();
    if (state.status === 'ready' || state.status === 'login_required') {
      const open = actions.createEl('button', { text: '打开编辑页', attr: { type: 'button' } });
      open.disabled = this.publishBusy;
      open.onclick = () => void this.openTask();
    }
    if (['queued', 'opening', 'failed', 'login_required'].includes(state.status)) {
      const retry = actions.createEl('button', { text: '重试', attr: { type: 'button' } });
      retry.disabled = extensionNeedsUpdate || this.publishBusy;
      retry.onclick = () => void this.retryTask();
    }
    const restart = actions.createEl('button', { text: '重新准备', attr: { type: 'button' } });
    restart.onclick = () => {
      this.publishTask = null;
      this.options.requestRender();
    };
  }

  private renderError(parent: HTMLElement): void {
    const error = parent.createDiv({ cls: 'wesight-xhs-error' });
    const icon = error.createSpan();
    setIcon(icon, 'circle-alert');
    error.createSpan({ text: this.error });
    const dismiss = error.createEl('button', { attr: { type: 'button', 'aria-label': '关闭错误提示' } });
    setIcon(dismiss, 'x');
    dismiss.onclick = () => {
      this.error = '';
      this.options.requestRender();
    };
  }

  private refreshFeedPreview(): void {
    const preview = document.querySelector<HTMLElement>('.wesight-jike-feed-body');
    preview?.setText(
      jikePostPreview(this.copy.body) || '生成或输入文案后，这里会显示即刻信息流效果。',
    );
  }

  private refreshCirclePreview(): void {
    document.querySelector<HTMLElement>('.wesight-jike-circle-preview')
      ?.setText(this.copy.circle || '待选择圈子');
  }

  private articleImages(): JikePostImage[] {
    if (!this.snapshot) return [];
    return quickTransformSourceImages(
      this.snapshot,
      vaultPath => this.options.vaultStore.getResourcePath(vaultPath),
    ).map(image => ({ ...image, source: 'article' as const }));
  }

  private xiaohongshuImages(): JikePostImage[] {
    return this.options.getXiaohongshuImages().map(page => ({
      id: `xiaohongshu-${page.id}`,
      vaultPath: page.vaultPath,
      fileName: page.fileName || page.vaultPath.split('/').pop() || `xiaohongshu-${page.pageNumber}.png`,
      mimeType: page.mimeType,
      label: `小红书配图 ${page.pageNumber}`,
      source: 'xiaohongshu' as const,
      previewUrl: page.previewUrl,
    }));
  }

  private imageResourceUrl(image: JikePostImage): string {
    return image.previewUrl?.trim() || this.options.vaultStore.getResourcePath(image.vaultPath);
  }

  private async readImageBinary(reference: string): Promise<ArrayBuffer> {
    if (!this.snapshot) throw new Error('当前文章还没有加载完成');
    return readSnapshotAssetReference(
      this.snapshot,
      reference,
      vaultPath => this.options.app.vault.adapter.readBinary(vaultPath),
    );
  }

  private availableImages(): JikePostImage[] {
    const seen = new Set<string>();
    return [...this.articleImages(), ...this.xiaohongshuImages(), ...this.images].filter(image => {
      if (seen.has(image.id)) return false;
      seen.add(image.id);
      return true;
    });
  }

  private moveImage(from: number, to: number): void {
    if (to < 0 || to >= this.images.length) return;
    const [image] = this.images.splice(from, 1);
    this.images.splice(to, 0, image);
    this.scheduleSave();
    this.options.requestRender();
  }

  private async pickLocalImages(): Promise<void> {
    if (!this.snapshot || this.operation) return;
    const input = document.body.createEl('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.multiple = true;
    input.hidden = true;
    input.onchange = () => void (async () => {
      const files = Array.from(input.files ?? []).slice(0, JIKE_POST_MAX_IMAGES - this.images.length);
      if (!files.length) return;
      this.operation = 'upload';
      this.options.requestRender();
      try {
        for (const file of files) {
          const imported = await this.options.vaultStore.importInputImage(
            `jike-post-${this.snapshot!.contentHash.slice(0, 16)}`,
            file.name,
            await file.arrayBuffer(),
          );
          this.images.push({
            id: `upload-${imported.id}`,
            vaultPath: imported.vaultPath,
            fileName: imported.fileName,
            mimeType: imported.mimeType,
            label: imported.fileName,
            source: 'upload',
            size: file.size,
          });
        }
        await this.save();
      } catch (error) {
        this.error = error instanceof Error ? error.message : '即刻配图导入失败';
      } finally {
        this.operation = null;
        input.remove();
        this.options.requestRender();
      }
    })();
    input.click();
  }

  private async generateCopy(): Promise<void> {
    if (!this.snapshot || this.operation) return;
    this.generationController?.abort();
    this.generationController = new AbortController();
    this.operation = 'copy';
    this.error = '';
    this.options.requestRender();
    const lifecycleVersion = this.lifecycleVersion;
    try {
      if (!await requireMemberFeature(this.options.app, this.options.auth, '转为图文')) return;
      if (lifecycleVersion !== this.lifecycleVersion || this.generationController.signal.aborted) return;
      const copy = await this.options.generationService.generateJikePostCopy(
        this.snapshot,
        this.copy.tone,
        this.customPrompt,
        this.generationController.signal,
      );
      if (lifecycleVersion !== this.lifecycleVersion || this.generationController.signal.aborted) return;
      this.copy = copy;
      await this.save();
      new Notice('即刻动态文案已生成，可继续手动调整。');
    } catch (error) {
      if (this.generationController.signal.aborted) return;
      this.error = error instanceof Error ? error.message : '即刻动态文案生成失败';
    } finally {
      this.operation = null;
      this.options.requestRender();
    }
  }

  private async startPublish(forcePair: boolean): Promise<void> {
    if (!this.snapshot || this.publishBusy) return;
    this.publishBusy = true;
    this.error = '';
    this.options.requestRender();
    const lifecycleVersion = this.lifecycleVersion;
    try {
      if (!await requireMemberFeature(this.options.app, this.options.auth, '浏览器发布助手')) return;
      if (lifecycleVersion !== this.lifecycleVersion) return;
      if (!requireBrowserConnection(this.options.bridge, this.options.openBrowserConnector, forcePair)) return;
      const validationErrors = validateJikePostPublishInput(this.copy, this.images);
      if (validationErrors.length) {
        new Notice(validationErrors[0]);
        return;
      }
      await this.save();
      if (lifecycleVersion !== this.lifecycleVersion) return;
      const publishSnapshot = await buildJikePostPublishSnapshot({
        source: this.snapshot,
        copy: this.copy,
        images: this.images,
        readBinary: reference => this.readImageBinary(reference),
      });
      if (lifecycleVersion !== this.lifecycleVersion) return;
      const result = this.options.bridge.createTask(publishSnapshot, ['jike-post'], forcePair);
      this.publishTask = result.task;
      window.open(result.handoffUrl, '_blank', 'noopener,noreferrer');
      new Notice('已交给 WeSight 发布助手准备即刻动态。');
    } catch (error) {
      this.error = error instanceof Error ? error.message : '即刻发布任务启动失败';
    } finally {
      this.publishBusy = false;
      this.options.requestRender();
    }
  }

  private async retryTask(): Promise<void> {
    if (!this.publishTask || this.publishBusy) return;
    this.publishBusy = true;
    this.options.requestRender();
    const lifecycleVersion = this.lifecycleVersion;
    try {
      if (!await requireMemberFeature(this.options.app, this.options.auth, '浏览器发布助手')) return;
      if (lifecycleVersion !== this.lifecycleVersion) return;
      if (!requireBrowserConnection(this.options.bridge, this.options.openBrowserConnector)) return;
      const url = this.options.bridge.createRetryUrl(this.publishTask.taskId, 'jike-post');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      this.error = error instanceof Error ? error.message : '重试即刻发布任务失败';
    } finally {
      this.publishBusy = false;
      this.options.requestRender();
    }
  }

  private async openTask(): Promise<void> {
    if (!this.publishTask || this.publishBusy) return;
    this.publishBusy = true;
    this.options.requestRender();
    const lifecycleVersion = this.lifecycleVersion;
    try {
      if (!await requireMemberFeature(this.options.app, this.options.auth, '浏览器发布助手')) return;
      if (lifecycleVersion !== this.lifecycleVersion) return;
      if (!requireBrowserConnection(this.options.bridge, this.options.openBrowserConnector)) return;
      const url = this.options.bridge.createOpenUrl(this.publishTask.taskId, 'jike-post');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      this.error = error instanceof Error ? error.message : '打开即刻编辑页失败';
    } finally {
      this.publishBusy = false;
      this.options.requestRender();
    }
  }

  private openChromeExtensions(): void { this.options.openBrowserConnector(); }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 500);
  }

  async save(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.snapshot) return;
    const record: JikePostDraftRecord = {
      version: 1,
      sourcePath: this.snapshot.sourcePath,
      contentHash: this.snapshot.contentHash,
      updatedAt: new Date().toISOString(),
      copy: this.copy,
      customPrompt: this.customPrompt,
      images: this.images,
    };
    await this.options.draftStore.save(record);
  }

  private async copyFullDraft(): Promise<void> {
    const text = buildJikePostText(this.copy.body, this.copy.topics);
    try {
      await navigator.clipboard.writeText(text);
      new Notice('即刻完整动态已复制。');
    } catch {
      this.error = '复制失败，请检查系统剪贴板权限。';
      this.options.requestRender();
    }
  }
}

function engineLabel(agentId: WeSightObsidianSettings['defaultAgentId']): string {
  if (agentId === 'claude') return 'Claude Code';
  if (agentId === 'codex') return 'Codex';
  return 'OpenCode';
}
