import type { WeChatPreviewSnapshot, WeChatAssetDraft } from './types';

export function assetMap(
  snapshot: WeChatPreviewSnapshot,
  urls?: Map<string, string>,
): Map<string, string> {
  return new Map(snapshot.assets.map((asset: WeChatAssetDraft) => [
    asset.token,
    urls?.get(asset.token) || asset.previewUrl,
  ]));
}

export function replaceAssetTokens(
  markdown: string,
  replacements: Map<string, string>,
): string {
  let result = markdown;
  for (const [token, url] of replacements) result = result.split(token).join(url);
  return result;
}
