import type { ChatImageArtifact } from '../types';
import type { QuickTransformPlatformId } from '../quickTransform/selection';
import type { XPostCopyDraft } from '../xPost/types';

export const XHS_VISUAL_CATEGORY_IDS = [
  'typography',
  'photography',
  'collage',
  'illustration',
  'infographic',
  'screenshot',
] as const;

export type XhsVisualCategoryId = (typeof XHS_VISUAL_CATEGORY_IDS)[number];

export interface XhsStyleDefinition {
  id: string;
  label: string;
  description: string;
}

export interface XhsCategoryDefinition {
  id: XhsVisualCategoryId;
  label: string;
  description: string;
  styles: XhsStyleDefinition[];
}

export interface XhsStyleChoice {
  categoryId: XhsVisualCategoryId;
  styleId: string;
}

export interface XhsStyleAlternative extends XhsStyleChoice {
  confidence: number;
}

export interface XhsStyleRecommendation extends XhsStyleChoice {
  confidence: number;
  reasons: string[];
  alternatives: XhsStyleAlternative[];
  source: 'local' | 'engine';
}

export interface XhsCopyDraft {
  title: string;
  body: string;
  tags: string[];
}

export interface XhsPageOutline {
  id: string;
  label: string;
  content: string;
}

export type XhsPageContentSource = 'article' | 'ai' | 'manual';

export interface XhsPageContent {
  pageNumber: number;
  label: string;
  text: string;
  textSource: XhsPageContentSource;
}

export interface XhsGeneratedPage extends ChatImageArtifact {
  pageNumber: number;
  label: string;
  fileName?: string;
  previewUrl?: string;
  generationContent?: XhsPageContent;
}

export type XhsImageRatio = '3:4' | '1:1' | '4:3';

export interface XhsImageReference {
  vaultPath: string;
  fileName: string;
  mimeType: string;
  previewUrl?: string;
}

export interface XhsDraftRecord {
  version: 1;
  sourcePath: string;
  contentHash: string;
  updatedAt: string;
  copy: XhsCopyDraft;
  style: XhsStyleChoice;
  recommendation: XhsStyleRecommendation;
  customStylePrompt: string;
  imageRatio?: XhsImageRatio;
  imageReferences?: XhsImageReference[];
  pageCount: number;
  pageContents?: XhsPageContent[];
  pages: XhsGeneratedPage[];
  quickTransform?: {
    targets: QuickTransformPlatformId[];
    targetsExplicit?: boolean;
    copyMode: 'shared' | 'platform';
    selectedImageIds: string[];
    previewPlatform: QuickTransformPlatformId;
    xPostCopy?: XPostCopyDraft;
  };
}

export const XHS_CATEGORIES: XhsCategoryDefinition[] = [
  {
    id: 'typography',
    label: '文字排版',
    description: '一句或一段文字的版式设计',
    styles: [
      { id: 'basic', label: '基础', description: '清晰大字与重点标记' },
      { id: 'comic', label: '美漫', description: '漫画粗字与人物插画' },
      { id: 'illustrated', label: '插图', description: '标题搭配轻量插图' },
      { id: 'minimal', label: '简约', description: '留白和克制配色' },
      { id: 'scribble', label: '涂写', description: '手写字与粗笔刷强调' },
      { id: 'sticky-note', label: '便签', description: '纸张与便利贴质感' },
      { id: 'geometric', label: '几何', description: '几何色块与网格' },
      { id: 'framed', label: '边框', description: '多层卡纸与醒目边框' },
      { id: 'handwritten', label: '手写', description: '自然手写与圈画' },
      { id: 'diffuse', label: '弥散', description: '柔和弥散渐变与贴纸' },
      { id: 'doodle', label: '涂鸦', description: '箭头线条与随手贴纸' },
      { id: 'memo', label: '备忘', description: '系统备忘录与选中标记' },
      { id: 'fresh', label: '清新', description: '浅蓝格纹与清爽配色' },
      { id: 'book-excerpt', label: '书摘', description: '纸张纹理与日期书摘' },
      { id: 'tech', label: '科技', description: '深色高对比科技感' },
      { id: 'light-shadow', label: '光影', description: '纸张光影与宋体排版' },
      { id: 'journal', label: '手帐', description: '撕纸、胶带与手帐元素' },
      { id: 'print', label: '印刷', description: '拼贴纸块与印刷质感' },
      { id: 'notes', label: '札记', description: '水彩纸张与绿色文字' },
      { id: 'soft', label: '柔和', description: '米白底色与酒红文字' },
      { id: 'greeting-card', label: '贺卡', description: '祝福语与轻快插画' },
    ],
  },
  {
    id: 'photography',
    label: '实拍摄影',
    description: '人物、产品与生活场景',
    styles: [
      { id: 'portrait', label: '人物纪实', description: '自然人物与真实环境' },
      { id: 'product', label: '产品实拍', description: '突出产品主体与细节' },
      { id: 'desktop', label: '桌面静物', description: '俯拍桌面和创作工具' },
      { id: 'lifestyle', label: '生活方式', description: '松弛的日常生活场景' },
      { id: 'store-visit', label: '探店随拍', description: '空间与消费体验记录' },
      { id: 'travel', label: '旅行氛围', description: '目的地与人物情绪' },
    ],
  },
  {
    id: 'collage',
    label: '杂志拼贴',
    description: '多图组合、纸张与胶片',
    styles: [
      { id: 'magazine', label: '杂志封面', description: '编辑感标题与主视觉' },
      { id: 'film', label: '胶片拼贴', description: '胶片边框与时间戳' },
      { id: 'scrapbook', label: '剪贴手帐', description: '纸张撕边和贴纸' },
      { id: 'grid', label: '多图宫格', description: '整齐图片网格' },
      { id: 'newspaper', label: '报纸排版', description: '报刊标题与分栏' },
      { id: 'moodboard', label: '情绪拼贴', description: '色彩与氛围素材组合' },
    ],
  },
  {
    id: 'illustration',
    label: '插画叙事',
    description: '手绘、漫画、扁平插画与 3D',
    styles: [
      { id: 'hand-drawn', label: '手绘日记', description: '轻松自然的手绘记录' },
      { id: 'flat', label: '扁平插画', description: '简洁形状与品牌配色' },
      { id: 'comic', label: '漫画分镜', description: '用分镜讲清过程' },
      { id: '3d', label: '3D 卡通', description: '立体角色与场景' },
      { id: 'watercolor', label: '水彩故事', description: '柔和水彩与情绪氛围' },
      { id: 'line-art', label: '线稿教程', description: '清晰线稿与步骤提示' },
    ],
  },
  {
    id: 'infographic',
    label: '信息图解',
    description: '步骤、清单、对比、流程与数据',
    styles: [
      { id: 'steps', label: '步骤清单', description: '按顺序拆解操作步骤' },
      { id: 'comparison', label: '前后对比', description: '突出变化与结果' },
      { id: 'timeline', label: '时间线', description: '按时间呈现过程' },
      { id: 'data-cards', label: '数据卡', description: '数字、结论与证据' },
      { id: 'flowchart', label: '流程图', description: '展示节点与流转关系' },
      { id: 'method', label: '方法拆解', description: '结构化提炼方法论' },
    ],
  },
  {
    id: 'screenshot',
    label: '截图增强',
    description: '界面、聊天、代码与重点标注',
    styles: [
      { id: 'tutorial', label: '教程标注', description: '截图加箭头和步骤' },
      { id: 'chat', label: '聊天记录', description: '突出关键对话内容' },
      { id: 'code', label: '代码讲解', description: '代码截图与重点说明' },
      { id: 'web', label: '网页拆解', description: '网页区域与功能标记' },
      { id: 'feature', label: '产品功能', description: '产品界面与卖点说明' },
      { id: 'case', label: '案例对比', description: '多张截图对照分析' },
    ],
  },
];

export function getXhsCategory(categoryId: XhsVisualCategoryId): XhsCategoryDefinition {
  return XHS_CATEGORIES.find(category => category.id === categoryId) ?? XHS_CATEGORIES[0];
}

export function getXhsStyle(categoryId: XhsVisualCategoryId, styleId: string): XhsStyleDefinition {
  const category = getXhsCategory(categoryId);
  return category.styles.find(style => style.id === styleId) ?? category.styles[0];
}
