import notes140 from '../../docs/releases/1.4.0.md?raw';
import notes130 from '../../docs/releases/1.3.0.md?raw';
import notes122 from '../../docs/releases/1.2.2.md?raw';
import notes121 from '../../docs/releases/1.2.1.md?raw';
import notes120 from '../../docs/releases/1.2.0.md?raw';
import notes110 from '../../docs/releases/1.1.0.md?raw';
import notes100 from '../../docs/releases/1.0.0.md?raw';

export const RECENT_RELEASE_NOTES = [
  { version: '1.4.0', title: '动态发布中心、X 图文与会员功能', markdown: notes140 },
  { version: '1.3.0', title: 'Git 团队协作与提交说明生成', markdown: notes130 },
  { version: '1.2.2', title: '词元API 更名与地址更新', markdown: notes122 },
  { version: '1.2.1', title: '修复 Chat 回复重复', markdown: notes121 },
  { version: '1.2.0', title: '模型厂商分类与选择器', markdown: notes120 },
  { version: '1.1.0', title: '会员模型与使用情况', markdown: notes110 },
  { version: '1.0.0', title: '文章转图文与多平台工作台', markdown: notes100 },
] as const;
