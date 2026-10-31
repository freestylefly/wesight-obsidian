export const CHROME_WEB_STORE_URL =
  'https://chromewebstore.google.com/detail/wesight-%E5%8F%91%E5%B8%83%E5%8A%A9%E6%89%8B/ocgepghgjgllnkhedapekeibaeklgoik';

export const CHROME_INSTALL_STEPS = [
  {
    title: '打开 Chrome 应用商店',
    description: '在要使用发布助手的浏览器中打开 WeSight 发布助手商店页。',
  },
  {
    title: '添加浏览器插件',
    description: '点击“添加至 Chrome”并确认添加扩展程序。Edge 如有提示，请允许来自其他商店的扩展。',
  },
  {
    title: '返回 Obsidian 连接',
    description: '安装完成后，回到上方点击“连接浏览器”或“重新连接”，并在安装了发布助手的浏览器中打开连接页。',
  },
] as const;
