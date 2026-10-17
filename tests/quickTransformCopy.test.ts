import { describe, expect, test } from 'vitest';

import {
  parseQuickTopics,
  sharedCopyRequirement,
  sharedCopyToJike,
  sharedCopyToWeibo,
} from '../src/quickTransform/copy';
import { buildWeiboPostText } from '../src/weiboPost/copy';
import { buildJikePostText } from '../src/jikePost/copy';

describe('quick transform copy mode', () => {
  const shared = {
    title: '统一标题',
    body: '三个平台使用同一段正文。',
    tags: ['AI 工具', '#效率'],
  };

  test('maps one shared copy to Weibo while preserving its tone', () => {
    expect(sharedCopyToWeibo(shared, {
      body: '旧正文',
      topics: [],
      tone: 'news',
    })).toEqual({
      body: '三个平台使用同一段正文。',
      topics: ['AI工具', '效率'],
      tone: 'news',
    });
  });

  test('maps one shared copy to Jike while preserving tone and circle', () => {
    expect(sharedCopyToJike(shared, {
      body: '旧正文',
      topics: [],
      tone: 'experience',
      circle: '产品经理的日常',
    })).toEqual({
      body: '三个平台使用同一段正文。',
      topics: ['AI工具', '效率'],
      tone: 'experience',
      circle: '产品经理的日常',
    });
  });

  test('adds platform-neutral generation guidance and parses editable topics', () => {
    expect(sharedCopyRequirement('保留技术细节')).toContain('三个平台都适合');
    expect(sharedCopyRequirement('保留技术细节')).toContain('保留技术细节');
    expect(parseQuickTopics('#AI工具 #企业 Agent，效率提升')).toEqual([
      'AI工具',
      '企业',
      'Agent',
      '效率提升',
    ]);
  });

  test('reserves the additional closing topic markers when sharing a 1000-character XHS draft', () => {
    const long = { title: '统一标题', body: '😀'.repeat(990), tags: ['AI', '效率'] };
    const weibo = sharedCopyToWeibo(long, { body: '', topics: [], tone: 'news' });
    const jike = sharedCopyToJike(long, { body: '', topics: [], tone: 'experience', circle: 'AI 探索站' });
    expect(Array.from(buildWeiboPostText(weibo.body, weibo.topics))).toHaveLength(1000);
    expect(Array.from(buildJikePostText(jike.body, jike.topics))).toHaveLength(1000);
    expect(weibo.body).toBe(jike.body);
    expect(long.body).toBe('😀'.repeat(990));
  });
});
