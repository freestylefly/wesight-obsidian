export interface StreamingPreviewViewport {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export const STREAMING_PREVIEW_BOTTOM_THRESHOLD = 56;
const STREAMING_PREVIEW_RESUME_THRESHOLD = 4;

export function isStreamingPreviewNearBottom(
  viewport: StreamingPreviewViewport,
  threshold = STREAMING_PREVIEW_BOTTOM_THRESHOLD,
): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= threshold;
}

export class StreamingPreviewAutoFollow {
  private active = false;
  private following = false;

  start(): void {
    this.active = true;
    this.following = true;
  }

  stop(): void {
    this.active = false;
    this.following = false;
  }

  pause(): boolean {
    if (!this.active || !this.following) return false;
    this.following = false;
    return true;
  }

  resume(): boolean {
    if (!this.active || this.following) return false;
    this.following = true;
    return true;
  }

  observeScroll(viewport: StreamingPreviewViewport, userInitiated: boolean): boolean {
    if (!this.active) return false;
    if (userInitiated) return this.pause();
    if (isStreamingPreviewNearBottom(viewport, STREAMING_PREVIEW_RESUME_THRESHOLD)) {
      return this.resume();
    }
    return false;
  }

  get isActive(): boolean {
    return this.active;
  }

  get isFollowing(): boolean {
    return this.active && this.following;
  }

  get isPaused(): boolean {
    return this.active && !this.following;
  }
}
