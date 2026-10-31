const MAX_UPLOAD_BYTES = 512 * 1024;
const MAX_EDGE = 2048;
const MIN_EDGE = 256;
const JPEG_QUALITIES = [0.85, 0.7, 0.55];

export interface TencentDocsUploadImage {
  body: ArrayBuffer;
  fileName: string;
}

/** Keep MCP requests small enough for the image tool's transport limit. */
export async function prepareTencentDocsImage(body: ArrayBuffer, fileName: string): Promise<TencentDocsUploadImage> {
  // Preserve GIF and vector files, and avoid recompressing small images.
  if (body.byteLength <= MAX_UPLOAD_BYTES || !/\.(?:png|jpe?g|webp|bmp)$/i.test(fileName)) {
    return { body, fileName };
  }

  let bitmap: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    bitmap = await createImageBitmap(new Blob([body]));
    if (!Number.isFinite(bitmap.width) || !Number.isFinite(bitmap.height) || bitmap.width < 1 || bitmap.height < 1) {
      throw new Error('Invalid image dimensions');
    }
    canvas = createEl('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');

    const originalEdge = Math.max(bitmap.width, bitmap.height);
    const minimumEdge = Math.min(MIN_EDGE, originalEdge);
    let edge = Math.min(MAX_EDGE, originalEdge);
    while (true) {
      const scale = edge / originalEdge;
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of JPEG_QUALITIES) {
        const output = await new Promise<Blob>((resolve, reject) => {
          canvas!.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image encoding failed')), 'image/jpeg', quality);
        });
        if (output.size > 0 && output.size <= MAX_UPLOAD_BYTES) {
          return { body: await output.arrayBuffer(), fileName: fileName.replace(/\.[^.]+$/, '.jpg') };
        }
      }
      if (edge <= minimumEdge) break;
      edge = Math.max(minimumEdge, Math.floor(edge * 0.75));
    }
  } catch {
    throw new Error('无法处理腾讯文档图片，请将图片另存为 PNG 或 JPG 后重试。');
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  throw new Error('图片压缩后仍超出腾讯文档上传限制，请缩小图片后重试。');
}
