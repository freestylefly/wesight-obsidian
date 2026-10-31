import {
  CHROME_WEB_STORE_URL,
  CHROME_INSTALL_STEPS,
} from '../src/multiPublish/installGuide';

describe('multi-platform extension install guide', () => {
  test('uses the published Chrome Web Store listing', () => {
    expect(CHROME_WEB_STORE_URL)
      .toBe('https://chromewebstore.google.com/detail/wesight-%E5%8F%91%E5%B8%83%E5%8A%A9%E6%89%8B/ocgepghgjgllnkhedapekeibaeklgoik');
  });

  test('guides users from store installation back to connecting in Obsidian', () => {
    expect(CHROME_INSTALL_STEPS.map(step => step.title)).toEqual([
      '打开 Chrome 应用商店',
      '添加浏览器插件',
      '返回 Obsidian 连接',
    ]);
    expect(CHROME_INSTALL_STEPS[1].description).toContain('添加至 Chrome');
    expect(CHROME_INSTALL_STEPS[2].description).toContain('连接浏览器');
  });
});
