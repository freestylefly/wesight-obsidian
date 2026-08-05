import {
  ItemView,
  MarkdownView,
  TFile,
  type ViewStateResult,
  WorkspaceLeaf,
  setIcon,
} from 'obsidian';

import {
  fetchWeChatArticleStats,
  resolveErrorMessage,
  type ArticleStatsResult,
} from '../wechat/articleStats';
import { CloudApiError } from '../share/cloudApi';
import type { CloudAuthService } from '../share/cloudAuth';
import { openBillingModal } from './billingModal';
import { WECHAT_ARTICLE_URL_FRONTMATTER_KEY, normalizeWeChatArticleUrl } from '../wechat/frontmatter';
import type { WeSightObsidianSettings } from '../types';

export const WESIGHT_WECHAT_ARTICLE_STATS_VIEW_TYPE = 'wesight-wechat-article-stats';

export interface WeChatArticleStatsViewDeps {
  auth: CloudAuthService;
  getSettings: () => WeSightObsidianSettings;
  openSettings: () => void;
}

export class WeChatArticleStatsView extends ItemView {
  private file: TFile | null = null;
  private articleUrl = '';
  private data: ArticleStatsResult | null = null;
  private error: string | null = null;
  private loading = false;
  private refreshTimer: number | null = null;
  
  

  constructor(leaf: WorkspaceLeaf, private readonly deps: WeChatArticleStatsViewDeps) {
    super(leaf);
  }

  override getViewType(): string {
    return WESIGHT_WECHAT_ARTICLE_STATS_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return '公众号文章数据';
  }

  override getIcon(): string {
    return 'bar-chart';
  }

  override async onOpen(): Promise<void> {
    this.containerEl.addClass('wesight-wechat-article-stats-view');
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (leaf?.view instanceof MarkdownView && leaf.view.file instanceof TFile) {
        void this.setFile(leaf.view.file);
      }
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (file instanceof TFile && file.path === this.file?.path) {
        if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
        this.refreshTimer = window.setTimeout(() => {
          this.refreshTimer = null;
          void this.setFile(file);
        }, 450);
      }
    }));
    if (!this.file) {
      const active = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (active instanceof TFile) this.file = active;
    }
    await this.refresh();
  }

  override async onClose(): Promise<void> {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  override getState(): Record<string, unknown> {
    return {
      filePath: this.file?.path ?? null,
    };
  }

  override async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
    const filePath = typeof state.filePath === 'string' ? state.filePath : '';
    const file = filePath ? this.app.vault.getAbstractFileByPath(filePath) : null;
    if (file instanceof TFile) this.file = file;
    await super.setState(state, result);
    if (this.contentEl.isConnected) await this.refresh();
  }

  async setFile(file: TFile): Promise<void> {
    if (this.file?.path === file.path && this.articleUrl) return;
    this.file = file;
    await this.leaf.setViewState({
      type: WESIGHT_WECHAT_ARTICLE_STATS_VIEW_TYPE,
      active: true,
      state: { filePath: file.path },
    });
    await this.refresh();
  }

  async setUrl(url: string): Promise<void> {
    this.articleUrl = url;
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    
   this.readArticleUrl();
   this.render();
   if (!this.articleUrl) return;
   this.loading = true;
   this.error = null;
   this.render();
    try {
      this.data = await fetchWeChatArticleStats(this.articleUrl, this.deps.auth);
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 402 && error.data) {
        openBillingModal(this.app, this.deps.auth, error.data as import('../share/types').CloudBillingSummary);
        this.error = error.message;
      } else {
        this.error = resolveErrorMessage(error);
      }
      this.data = null;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private readArticleUrl(): void {
    this.articleUrl = '';
    if (!this.file) return;
    const cache = this.app.metadataCache.getFileCache(this.file);
    const url = normalizeWeChatArticleUrl(cache?.frontmatter?.[WECHAT_ARTICLE_URL_FRONTMATTER_KEY]);
    this.articleUrl = url ?? '';
  }

  private render(): void {
    
    this.contentEl.empty();
    this.renderHeader();
    if (this.loading) {
      this.renderLoading();
      return;
    }
    if (!this.articleUrl) {
      this.renderEmpty('当前笔记没有登记公众号文章链接。');
      return;
    }
    if (this.error) {
      this.renderError(this.error);
      return;
    }
    if (this.data) {
      this.renderData(this.data);
      return;
    }
    this.renderEmpty('点击刷新按钮加载文章数据。');
  }

  private renderHeader(): void {
    const header = this.contentEl.createDiv({ cls: 'wesight-wechat-article-stats-header' });
    const title = header.createDiv({ cls: 'wesight-wechat-article-stats-title' });
    title.createEl('strong', { text: '公众号文章数据' });
    const actions = header.createDiv({ cls: 'wesight-wechat-article-stats-actions' });
    const refresh = actions.createEl('button', {
      cls: 'clickable-icon',
      attr: { type: 'button', 'aria-label': '刷新文章数据' },
    });
    setIcon(refresh, 'refresh-cw');
    refresh.onclick = () => void this.refresh();
    if (this.articleUrl) {
      const link = header.createEl('a', {
        cls: 'wesight-wechat-article-stats-link',
        href: this.articleUrl,
        attr: { target: '_blank', rel: 'noopener noreferrer' },
      });
      link.setText(this.truncateUrl(this.articleUrl));
      link.title = this.articleUrl;
    }
  }

  private renderLoading(): void {
    
    const loading = this.contentEl.createDiv({ cls: 'wesight-wechat-article-stats-loading' });
    const icon = loading.createSpan();
    setIcon(icon, 'loader-circle');
    loading.createSpan({ text: '正在加载文章数据…' });
  }

  private renderEmpty(message: string): void {
    
    const empty = this.contentEl.createDiv({ cls: 'wesight-wechat-article-stats-empty' });
    const icon = empty.createSpan();
    setIcon(icon, 'file-text');
    empty.createSpan({ text: message });
  }

  private renderError(message: string): void {
    const error = this.contentEl.createDiv({ cls: 'wesight-wechat-article-stats-error' });
    const icon = error.createSpan();
    setIcon(icon, 'circle-alert');
    const copy = error.createDiv();
    copy.createEl('strong', { text: '加载失败' });
    copy.createSpan({ text: message });
    const retry = this.contentEl.createEl('button', {
      cls: 'wesight-wechat-article-stats-retry',
      text: '重试',
      attr: { type: 'button' },
    });
    retry.onclick = () => void this.refresh();
  }


  private renderData(result: ArticleStatsResult): void {
    this.renderMetrics(result.data);
    this.renderChart(result.data);
    const summary = this.contentEl.createDiv({ cls: 'wesight-wechat-article-stats-summary' });
    summary.createSpan({ text: `状态码：${result.code}` });
    if (result.message) {
      summary.createSpan({ text: result.message });
    }
    if (!result.data || Object.keys(result.data).length === 0) {
      this.renderEmpty('接口未返回可展示的数据字段。');
      return;
    }
    const list = this.contentEl.createDiv({ cls: 'wesight-wechat-article-stats-list' });
    for (const [key, value] of Object.entries(result.data)) {
      const row = list.createDiv({ cls: 'wesight-wechat-article-stats-row' });
      row.createDiv({ cls: 'wesight-wechat-article-stats-key', text: key });
      const valueEl = row.createDiv({ cls: 'wesight-wechat-article-stats-value' });
      valueEl.setText(this.formatValue(value));
    }
  }

  private renderMetrics(data: Record<string, unknown> | null): void {
    if (!data) return;
    const read = this.parseNumber(data.read);
    const zan = this.parseNumber(data.zan);
    const share = this.parseNumber(data.share_num);
    const looking = this.parseNumber(data.looking);
    const collect = this.parseNumber(data.collect_num);
    const comment = this.parseNumber(data.comment_count);
    if (read === null) return;

    const metrics = this.contentEl.createDiv({ cls: 'wesight-wechat-article-stats-metrics' });
    this.metricCard(metrics, '阅读数', read);
    this.metricCard(metrics, '点赞数', zan);
    this.metricCard(metrics, '转发数', share);
    this.metricCard(metrics, '在看数', looking);
    this.metricCard(metrics, '收藏数', collect);
    this.metricCard(metrics, '评论数', comment);
    this.metricCard(metrics, '赞阅比', zan !== null ? this.formatRatio(zan / read) : '—');
    this.metricCard(metrics, '转阅比', share !== null ? this.formatRatio(share / read) : '—');
  }

  private metricCard(parent: HTMLElement, label: string, value: string | number | null): void {
    const card = parent.createDiv({ cls: 'wesight-wechat-article-stats-metric-card' });
    card.createDiv({ cls: 'wesight-wechat-article-stats-metric-value', text: value === null ? '—' : String(value) });
    card.createDiv({ cls: 'wesight-wechat-article-stats-metric-label', text: label });
  }

  private renderChart(data: Record<string, unknown> | null): void {
    if (!data) return;
    const items = [
      { label: '阅读', value: this.parseNumber(data.read), color: '#3b82f6' },
      { label: '点赞', value: this.parseNumber(data.zan), color: '#ef4444' },
      { label: '转发', value: this.parseNumber(data.share_num), color: '#10b981' },
      { label: '在看', value: this.parseNumber(data.looking), color: '#f59e0b' },
      { label: '收藏', value: this.parseNumber(data.collect_num), color: '#8b5cf6' },
      { label: '评论', value: this.parseNumber(data.comment_count), color: '#06b6d4' },
    ].filter((item): item is { label: string; value: number; color: string } => item.value !== null);
    if (items.length < 2) return;
    const max = Math.max(...items.map(item => item.value));
    const chart = this.contentEl.createDiv({ cls: 'wesight-wechat-article-stats-chart' });
    for (const item of items) {
      const row = chart.createDiv({ cls: 'wesight-wechat-article-stats-chart-row' });
      row.createDiv({ cls: 'wesight-wechat-article-stats-chart-label', text: item.label });
      const barWrap = row.createDiv({ cls: 'wesight-wechat-article-stats-chart-bar-wrap' });
      const bar = barWrap.createDiv({ cls: 'wesight-wechat-article-stats-chart-bar' });
      bar.style.width = `${(item.value / max) * 100}%`;
      bar.style.backgroundColor = item.color;
      barWrap.createDiv({ cls: 'wesight-wechat-article-stats-chart-value', text: String(item.value) });
    }
  }

  private parseNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return null;
  }

  private formatRatio(value: number): string {
    if (!Number.isFinite(value)) return '—';
    return `${(value * 100).toFixed(2)}%`;
  }


  private formatValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return '—';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return '[无法序列化]';
    }
  }

  private truncateUrl(url: string): string {
    if (url.length <= 48) return url;
    return `${url.slice(0, 22)}…${url.slice(-22)}`;
  }
}
