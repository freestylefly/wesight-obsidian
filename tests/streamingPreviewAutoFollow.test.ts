import {
  isStreamingPreviewNearBottom,
  StreamingPreviewAutoFollow,
} from '../src/ui/streamingPreviewAutoFollow';

const viewport = (scrollTop: number, scrollHeight = 1000, clientHeight = 400) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('streaming preview auto follow', () => {
  test('starts by following new content and stops cleanly', () => {
    const follow = new StreamingPreviewAutoFollow();

    follow.start();
    expect(follow.isFollowing).toBe(true);
    expect(follow.isPaused).toBe(false);

    follow.stop();
    expect(follow.isActive).toBe(false);
    expect(follow.isFollowing).toBe(false);
  });

  test('pauses after a user scrolls upward away from the bottom', () => {
    const follow = new StreamingPreviewAutoFollow();
    follow.start();

    expect(follow.observeScroll(viewport(200), true)).toBe(true);
    expect(follow.isPaused).toBe(true);
  });

  test('keeps following during programmatic smooth scrolling', () => {
    const follow = new StreamingPreviewAutoFollow();
    follow.start();

    expect(follow.observeScroll(viewport(200), false)).toBe(false);
    expect(follow.isFollowing).toBe(true);
  });

  test('resumes after returning to the bottom or requesting follow', () => {
    const follow = new StreamingPreviewAutoFollow();
    follow.start();
    follow.pause();

    expect(follow.observeScroll(viewport(598), false)).toBe(true);
    expect(follow.isFollowing).toBe(true);

    follow.pause();
    expect(follow.resume()).toBe(true);
    expect(follow.isFollowing).toBe(true);
  });

  test('stays paused after a small upward movement near the bottom', () => {
    const follow = new StreamingPreviewAutoFollow();
    follow.start();
    follow.pause();

    expect(follow.observeScroll(viewport(570), true)).toBe(false);
    expect(follow.isPaused).toBe(true);
  });

  test('prioritizes an upward user gesture at the bottom', () => {
    const follow = new StreamingPreviewAutoFollow();
    follow.start();

    expect(follow.observeScroll(viewport(598), true)).toBe(true);
    expect(follow.isPaused).toBe(true);
  });

  test('uses a small bottom tolerance for image height changes', () => {
    expect(isStreamingPreviewNearBottom(viewport(544))).toBe(true);
    expect(isStreamingPreviewNearBottom(viewport(520))).toBe(false);
  });
});
