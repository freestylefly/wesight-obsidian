import { afterEach, describe, expect, test, vi } from 'vitest';

import { prepareTencentDocsImage } from '../src/tencentDocs/imageUpload';

const LIMIT = 512 * 1024;

function fixture(sizes: number[], dimensions = { width: 4000, height: 2000 }) {
  const close = vi.fn();
  const bitmap = { ...dimensions, close };
  const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
  const encoded: Array<{ width: number; height: number; type: string; quality: number }> = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: (blob: Blob | null) => void, type: string, quality: number) => {
      encoded.push({ width: canvas.width, height: canvas.height, type, quality });
      const size = sizes[Math.min(encoded.length - 1, sizes.length - 1)];
      callback(new Blob([new ArrayBuffer(size)], { type }));
    }),
  };
  const decode = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('createEl', vi.fn(() => canvas));
  return { bitmap, close, context, canvas, encoded, decode };
}

afterEach(() => vi.unstubAllGlobals());

describe('Tencent Docs upload image preparation', () => {
  test('preserves small images and animated or vector files without decoding', async () => {
    const { decode } = fixture([100]);
    for (const [size, fileName] of [[LIMIT, '图.png'], [LIMIT + 1, '图.GIF'], [LIMIT + 1, '图.svg']] as const) {
      const body = new ArrayBuffer(size);
      expect(await prepareTencentDocsImage(body, fileName)).toEqual({ body, fileName });
    }
    expect(decode).not.toHaveBeenCalled();
  });

  test('compresses oversized raster images, retaining aspect ratio with a white background', async () => {
    const { encoded, context, close, canvas } = fixture([LIMIT + 100, 120_000]);
    const result = await prepareTencentDocsImage(new ArrayBuffer(LIMIT + 1), '图片.PNG');
    expect(result.fileName).toBe('图片.jpg');
    expect(result.body.byteLength).toBe(120_000);
    expect(encoded).toEqual([
      { width: 2048, height: 1024, type: 'image/jpeg', quality: 0.85 },
      { width: 2048, height: 1024, type: 'image/jpeg', quality: 0.7 },
    ]);
    expect(context.fillStyle).toBe('#fff');
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 2048, 1024);
    expect(context.fillRect.mock.invocationCallOrder[0]).toBeLessThan(context.drawImage.mock.invocationCallOrder[0]);
    expect(close).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  test('reduces resolution after exhausting quality levels', async () => {
    const { encoded } = fixture([LIMIT + 1, LIMIT + 1, LIMIT + 1, LIMIT]);
    await prepareTencentDocsImage(new ArrayBuffer(LIMIT + 1), 'photo.webp');
    expect(encoded[3]).toEqual({ width: 1536, height: 768, type: 'image/jpeg', quality: 0.85 });
  });

  test('does not upscale small dimensions during compression', async () => {
    const { encoded } = fixture([100], { width: 100, height: 50 });
    await prepareTencentDocsImage(new ArrayBuffer(LIMIT + 1), 'photo.bmp');
    expect(encoded[0]).toMatchObject({ width: 100, height: 50 });
  });

  test('bounds compression attempts and releases decoded images when the limit cannot be met', async () => {
    const { encoded, close } = fixture([LIMIT + 1]);
    await expect(prepareTencentDocsImage(new ArrayBuffer(LIMIT + 1), 'photo.jpg')).rejects.toThrow('图片压缩后仍超出腾讯文档上传限制');
    expect(encoded.at(-1)).toMatchObject({ width: 256, height: 128 });
    expect(encoded.length).toBeLessThanOrEqual(30);
    expect(close).toHaveBeenCalledOnce();
  });

  test('reports decoding failures without exposing decoder details', async () => {
    const { decode } = fixture([100]);
    decode.mockRejectedValue(new Error('private decoder details'));
    await expect(prepareTencentDocsImage(new ArrayBuffer(LIMIT + 1), 'photo.png')).rejects.toThrow('无法处理腾讯文档图片');
  });

  test('releases the bitmap when the canvas cannot export', async () => {
    const { canvas, close } = fixture([100]);
    canvas.toBlob.mockImplementation(callback => callback(null));
    await expect(prepareTencentDocsImage(new ArrayBuffer(LIMIT + 1), 'photo.png')).rejects.toThrow('无法处理腾讯文档图片');
    expect(close).toHaveBeenCalledOnce();
  });
});
