import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fragmentRange, preparePostLiveInputs } from '../src/post-live';

test('locates a late cut by actual timestamps despite segment-duration drift', async () => {
  let probes = 0;
  const range = await fragmentRange(4097, 6427, 6459, async index => {
    probes++;
    return index * 5 - (index ? 5.466667 : 0);
  });
  expect(range).toEqual({ first: 1285, last: 1293 });
  expect(probes).toBeLessThan(30);
});

test('keeps beginning and ending cuts inside the fragment list', async () => {
  expect(await fragmentRange(3, 0, 2, async index => index * 5)).toEqual({ first: 0, last: 1 });
  expect(await fragmentRange(3, 10, 15, async index => index * 5)).toEqual({ first: 1, last: 2 });
});

test('assembles selected fragments and independently aligns audio/video to the requested timestamp', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clipper-post-live-'));
  const originalFetch = globalThis.fetch;
  const downloaded: string[] = [];
  globalThis.fetch = (async (url: URL) => {
    downloaded.push(url.href);
    return new Response(new Uint8Array([Number(url.searchParams.get('sq'))]));
  }) as typeof fetch;
  try {
    const fragments = Array.from({ length: 20 }, (_, index) => ({ url: `https://test.googlevideo.com/videoplayback?sq=${index}` }));
    const output = path.join(directory, 'clip.mp4');
    const args = await preparePostLiveInputs({ requested_formats: [
      { protocol: 'http_dash_segments', vcodec: 'avc1', acodec: 'none', fragments },
      { protocol: 'http_dash_segments', vcodec: 'none', acodec: 'aac', fragments },
    ] }, 32, 39, output, 'ffprobe', async (_command, args) => {
      const match = args.at(-1)!.match(/track-(\d+)-fragment-(\d+)/)!;
      return { format: { start_time: String(Number(match[2]) * 5 + Number(match[1]) * 0.02) } };
    });
    expect(args).toEqual([
      '-ss', '7.000000', '-i', `${output}-track-0.mp4`,
      '-ss', '6.980000', '-i', `${output}-track-1.mp4`,
      '-t', '7', '-map', '0:v:0', '-map', '1:a:0',
    ]);
    expect([...await fs.readFile(`${output}-track-0.mp4`)]).toEqual([5, 6, 7, 8]);
    expect(downloaded.length).toBeLessThan(40);
  } finally {
    globalThis.fetch = originalFetch;
    for (const file of await fs.readdir(directory)) await fs.unlink(path.join(directory, file));
    await fs.rmdir(directory);
  }
});

test('rejects unavailable fragment metadata instead of opening the final-fragment URL', async () => {
  await expect(preparePostLiveInputs({ protocol: 'https' }, 0, 1, 'unused', 'ffprobe', async () => ({})))
    .rejects.toThrow('not exposed downloadable fragments');
});

test('rejects unexpected fragment hosts before fetching', async () => {
  await expect(preparePostLiveInputs({ protocol: 'http_dash_segments', fragments: [{ url: 'http://localhost/private' }] }, 0, 1, 'unused', 'ffprobe', async () => ({})))
    .rejects.toThrow('Unexpected livestream fragment host');
});
