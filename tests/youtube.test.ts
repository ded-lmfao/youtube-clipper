import { expect, test } from 'bun:test';
import { getVideoId } from '../frontend/lib/youtube';

test('recognizes live, watch, short, embed and shared YouTube links', () => {
  for (const url of [
    'https://www.youtube.com/live/Gu89XvdGoe0',
    'https://www.youtube.com/watch?v=Gu89XvdGoe0&t=20',
    'https://youtu.be/Gu89XvdGoe0?si=share',
    'https://m.youtube.com/shorts/Gu89XvdGoe0',
    'https://www.youtube.com/embed/Gu89XvdGoe0',
  ]) expect(getVideoId(url)).toBe('Gu89XvdGoe0');
});

test('ignores incomplete URLs and non-YouTube hosts', () => {
  for (const url of ['', 'https://www.youtube.com/watch?v=partial',
    'https://example.com/watch?v=Gu89XvdGoe0',
    'https://youtube.com.example.com/live/Gu89XvdGoe0',
    'https://www.youtube.com/live/']) expect(getVideoId(url)).toBeNull();
});
