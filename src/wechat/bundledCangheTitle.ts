import skillRules from '../skills/canghe-wechat-title/SKILL.md?raw';
import titlePatterns from '../skills/canghe-wechat-title/references/canghe-title-patterns.md?raw';

export const CANGHE_TITLE_SKILL_PROMPT = [
  skillRules,
  '',
  '# 参考样本',
  '',
  titlePatterns,
].join('\n');
