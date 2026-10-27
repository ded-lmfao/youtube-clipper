import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const video = Buffer.from('local video fixture');
let failProcessing = false;
let outputPath = '';
let downloadArgs: string[] = [];
let metadata = { live_status: 'not_live', duration: 60 };
let emptyDownload = false;
let emptyConversion = false;
let conversions = 0;
beforeEach(() => {
  failProcessing = false;
  metadata = { live_status: 'not_live', duration: 60 };
  emptyDownload = false;
  emptyConversion = false;
  conversions = 0;
  downloadArgs = [];
});
mock.module('child_process', () => ({
  spawn(command: string, args: string[]) {
    const process = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      stdout: Object.assign(new EventEmitter(), { resume() {} }),
      kill() {},
    });
    setTimeout(() => {
      if (failProcessing) {
        process.emit('error', new Error('Test encoder failure'));
        return;
      }
      const isFfmpeg = /^ffmpeg(?:\.exe)?$/.test(path.basename(command));
      const isProbe = /^ffprobe(?:\.exe)?$/.test(path.basename(command));
      if (args.includes('--dump-single-json') || isProbe) {
        const empty = emptyDownload || (emptyConversion && args.at(-1)?.endsWith('-fast.mp4'));
        process.stdout.emit('data', JSON.stringify(isProbe
          ? { streams: empty ? [] : [{ codec_type: 'video' }], format: empty ? {} : { duration: '1.0' } }
          : metadata));
        process.emit('close', 0);
        return;
      }
      if (isFfmpeg) conversions++;
      const destination = isFfmpeg ? args[args.length - 1] : args[args.indexOf('-o') + 1];
      if (!isFfmpeg) {
        outputPath = destination;
        downloadArgs = args;
      }
      fs.writeFileSync(destination, video);
      process.emit('close', 0);
    }, 20);
    return process;
  },
}));

process.env.PORT = '0';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
const { server } = await import('../src/index');
if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => server.close());
const payload = { url: 'https://www.youtube.com/watch?v=test', startTime: '00:00:00', endTime: '00:00:01' };
const create = (body = payload) => fetch(base + '/api/clip', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
async function waitForJob(id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await (await fetch(base + '/api/clip/' + id)).json();
    if (job.status !== 'processing') return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Job did not finish');
}

test('local startup, validation, download bytes, and cleanup without Supabase', async () => {
  expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  expect((await fetch(base + '/api/ping')).status).toBe(200);
  expect((await fetch(base + '/api/ping', { headers: { Origin: 'https://example.com' } })).status).toBe(403);
  expect((await create({ ...payload, endTime: '00:00:00' })).status).toBe(400);
  const response = await create();
  expect(response.status).toBe(202);
  const { id } = await response.json();
  expect((await fetch(base + '/api/clip/' + id + '/cleanup', { method: 'DELETE' })).status).toBe(409);
  const job = await waitForJob(id);
  expect(job).toEqual({ status: 'ready' });
  expect(downloadArgs).toContain('--force-keyframes-at-cuts');
  expect(downloadArgs).not.toContain('--downloader-args');
  const download = await fetch(base + '/api/clip/' + id + '/file');
  expect(download.headers.get('content-disposition')).toContain('attachment; filename="clip.mp4"');
  expect(download.headers.get('cache-control')).toBe('no-store');
  expect(Buffer.from(await download.arrayBuffer())).toEqual(video);
  expect(fs.existsSync(outputPath)).toBe(true);
  expect((await fetch(base + '/api/clip/' + id + '/cleanup', { method: 'DELETE' })).status).toBe(200);
  expect(fs.existsSync(outputPath)).toBe(false);
  expect((await fetch(base + '/api/clip/' + id + '/file')).status).toBe(404);
});

test('processing errors are reported without a download URL', async () => {
  failProcessing = true;
  const { id } = await (await create()).json();
  const job = await waitForJob(id);
  expect(job).toEqual({ status: 'error', error: 'Test encoder failure' });
  expect((await fetch(base + '/api/clip/' + id + '/file')).status).toBe(409);
  await fetch(base + '/api/clip/' + id + '/cleanup', { method: 'DELETE' });
});

for (const liveStatus of ['is_live', 'is_upcoming']) {
  test(`rejects ${liveStatus} before downloading`, async () => {
    metadata.live_status = liveStatus;
    const { id } = await (await create()).json();
    const job = await waitForJob(id);
    expect(job.status).toBe('error');
    expect(job.error).toContain('processing');
    expect(downloadArgs).toEqual([]);
    expect(conversions).toBe(0);
    expect((await fetch(base + '/api/clip/' + id + '/file')).status).toBe(409);
    await fetch(base + '/api/clip/' + id + '/cleanup', { method: 'DELETE' });
  });
}

test('processed livestream recordings can be clipped', async () => {
  metadata.live_status = 'was_live';
  const { id } = await (await create()).json();
  expect(await waitForJob(id)).toEqual({ status: 'ready' });
  await fetch(base + '/api/clip/' + id + '/cleanup', { method: 'DELETE' });
});

test('rejects timestamps beyond the recording duration', async () => {
  const { id } = await (await create({ ...payload, endTime: '00:01:01' })).json();
  expect((await waitForJob(id)).error).toContain('exceeds the video duration');
  expect(downloadArgs).toEqual([]);
  await fetch(base + '/api/clip/' + id + '/cleanup', { method: 'DELETE' });
});

for (const stage of ['download', 'conversion']) {
  test(`rejects empty ${stage} despite successful tool exit and removes artifacts`, async () => {
    emptyDownload = stage === 'download';
    emptyConversion = stage === 'conversion';
    const { id } = await (await create()).json();
    expect((await waitForJob(id)).error).toContain('contains no video');
    expect(conversions).toBe(stage === 'download' ? 0 : 1);
    expect((await fetch(base + '/api/clip/' + id + '/file')).status).toBe(409);
    await fetch(base + '/api/clip/' + id + '/cleanup', { method: 'DELETE' });
    expect(fs.readdirSync(path.dirname(outputPath)).some(name => name.includes(id))).toBe(false);
  });
}
