import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

type Format = {
  protocol: string;
  vcodec?: string;
  acodec?: string;
  fragments?: { url: string }[];
  http_headers?: Record<string, string>;
};

// Segment lengths can drift from target_duration. Locate cuts using actual PTS.
export async function fragmentRange(count: number, start: number, end: number, timestamp: (index: number) => Promise<number>) {
  async function floor(time: number) {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (await timestamp(middle) <= time) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, low - 1);
  }
  // Keep one preceding segment for decoding and one following segment for the end.
  return { first: Math.max(0, await floor(start) - 1), last: Math.min(count - 1, await floor(end) + 1) };
}

export async function preparePostLiveInputs(
  info: { requested_formats?: Format[]; http_headers?: Record<string, string> } & Partial<Format>,
  start: number, end: number, outputPath: string, ffprobePath: string,
  readJson: (command: string, args: string[]) => Promise<any>,
): Promise<string[]> {
  const formats = info.requested_formats || [info as Format];
  if (!formats.length || formats.some(f => f.protocol !== 'http_dash_segments' || !f.fragments?.length)) {
    throw new Error('YouTube has not exposed downloadable fragments for this recording yet. Retry after processing finishes.');
  }
  const inputArgs: string[] = [];
  for (const [track, format] of formats.entries()) {
    const fragments = format.fragments!;
    const cached = new Map<number, string>();
    const timestamps = new Map<number, number>();
    async function download(index: number): Promise<string> {
      if (cached.has(index)) return cached.get(index)!;
      const url = new URL(fragments[index].url);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.googlevideo.com')) {
        throw new Error('Unexpected livestream fragment host');
      }
      const file = `${outputPath}-track-${track}-fragment-${index}.mp4`;
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetch(url, {
            headers: format.http_headers || info.http_headers,
            redirect: 'error', signal: AbortSignal.timeout(30000),
          });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error(`Livestream fragment ${index} is unavailable (HTTP ${response.status})`);
          }
          await pipeline(Readable.fromWeb(response.body as any), fs.createWriteStream(file));
          cached.set(index, file);
          return file;
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
    }
    async function timestamp(index: number): Promise<number> {
      if (timestamps.has(index)) return timestamps.get(index)!;
      const probe = await readJson(ffprobePath, [
        '-v', 'error', '-show_entries', 'format=start_time', '-of', 'json', await download(index),
      ]);
      const time = Number(probe.format?.start_time);
      if (!Number.isFinite(time)) throw new Error('Livestream fragment has no usable timestamp');
      timestamps.set(index, time);
      return time;
    }
    const range = await fragmentRange(fragments.length, start, end, timestamp);
    const firstTime = await timestamp(range.first);
    if (firstTime > start) throw new Error('The requested start is outside the available livestream recording');
    const trackPath = `${outputPath}-track-${track}.mp4`;
    for (let index = range.first; index <= range.last; index++) {
      await pipeline(fs.createReadStream(await download(index)), fs.createWriteStream(trackPath, { flags: index === range.first ? 'w' : 'a' }));
    }
    inputArgs.push('-ss', (start - firstTime).toFixed(6), '-i', trackPath);
  }
  // Each input is cut at the same broadcast timestamp, preserving A/V sync.
  const video = formats.findIndex(f => f.vcodec && f.vcodec !== 'none');
  const audio = formats.findIndex(f => f.acodec && f.acodec !== 'none');
  if (video < 0) throw new Error('The selected livestream format has no video');
  inputArgs.push('-t', String(end - start), '-map', `${video}:v:0`);
  if (audio >= 0) inputArgs.push('-map', `${audio}:a:0`);
  return inputArgs;
}
