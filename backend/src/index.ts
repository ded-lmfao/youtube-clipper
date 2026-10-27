import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { preparePostLiveInputs } from './post-live';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

const allowedOrigin = "http://localhost:3000";
app.use((req, res, next) => {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(req.hostname) ||
      (req.headers.origin && ![allowedOrigin, "http://127.0.0.1:3000"].includes(req.headers.origin))) {
    return res.status(403).json({ error: "Local requests only" });
  }
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

const uploadsDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

interface Job {
  id: string;
  status: 'processing' | 'ready' | 'error';
  filePath: string;
  error?: string;
}
const jobs = new Map<string, Job>();
const bundledYtDlp = path.resolve(__dirname, process.platform === 'win32' ? '../bin/yt-dlp.exe' : '../bin/yt-dlp');
const ytDlpPath = fs.existsSync(bundledYtDlp) ? bundledYtDlp : 'yt-dlp';
const bundledFfmpeg = path.resolve(__dirname, '../bin/ffmpeg.exe');
const ffmpegPath = process.platform === 'win32' && fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg';
const bundledFfprobe = path.resolve(__dirname, '../bin/ffprobe.exe');
const ffprobePath = process.platform === 'win32' && fs.existsSync(bundledFfprobe) ? bundledFfprobe : 'ffprobe';
const ytDlpToolArgs = [
  '--js-runtimes', `bun:${process.execPath}`,
  ...(ffmpegPath === bundledFfmpeg ? ['--ffmpeg-location', path.dirname(bundledFfmpeg)] : []),
  '--no-playlist',
];
function createJobId() { return randomUUID(); }

async function readToolJson(command: string, args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} inspection timed out; please retry`));
    }, 30000);
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`${path.basename(command)} inspection failed: ${stderr.trim() || `exit code ${code}`}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch {
        reject(new Error(`${path.basename(command)} returned invalid metadata`));
      }
    });
  });
}

async function validateClip(filePath: string, expectedDuration?: number): Promise<void> {
  const info = await readToolJson(ffprobePath, [
    '-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', filePath,
  ]);
  if (!info.streams?.some((stream: { codec_type: string }) => stream.codec_type === 'video') ||
      !(Number(info.format?.duration) > 0)) {
    throw new Error('The requested section contains no video. Check the timestamps; if this was a livestream, wait for YouTube to finish processing the recording and retry.');
  }
  if (expectedDuration !== undefined && Math.abs(Number(info.format.duration) - expectedDuration) > 0.5) {
    throw new Error('The downloaded clip is incomplete. YouTube may no longer have all requested livestream fragments; please retry later.');
  }
}

function timeToSeconds(timeStr: string): number {
  const parts = timeStr.split(':');
  return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
}

function secondsToTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0')}`;
}

async function adjustSubtitleTimestamps(inputPath: string, outputPath: string, startTime: string): Promise<void> {
  const startSeconds = timeToSeconds(startTime);
  const content = await fs.promises.readFile(inputPath, 'utf-8');
  
  // Regex to match VTT timestamp lines (e.g., "00:01:30.000 --> 00:01:35.000")
  const timestampRegex = /(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/g;
  
  const adjustedContent = content.replace(timestampRegex, (match, start, end) => {
    const startSec = timeToSeconds(start) - startSeconds;
    const endSec = timeToSeconds(end) - startSeconds;
    
    // Skip negative timestamps (before clip start)
    if (startSec < 0) return match; // Keep original, will be filtered out by video duration
    
    return `${secondsToTime(startSec)} --> ${secondsToTime(endSec)}`;
  });
  
  await fs.promises.writeFile(outputPath, adjustedContent, 'utf-8');
}

app.post("/api/clip", async (req, res) => {
  const { url, startTime, endTime, subtitles, formatId } = req.body || {};
  let videoUrl: URL;
  try { videoUrl = new URL(url); } catch {
    return res.status(400).json({ error: "A YouTube URL is required" });
  }
  if (videoUrl.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(videoUrl.hostname)) {
    return res.status(400).json({ error: "Use an HTTPS YouTube URL" });
  }
  const timestamp = /^\d{2}:[0-5]\d:[0-5]\d$/;
  if (typeof startTime !== 'string' || typeof endTime !== 'string' || !timestamp.test(startTime) || !timestamp.test(endTime) || timeToSeconds(endTime) <= timeToSeconds(startTime)) {
    return res.status(400).json({ error: "Use HH:MM:SS timestamps with end after start" });
  }
  if ((formatId !== undefined && typeof formatId !== 'string') || (subtitles !== undefined && typeof subtitles !== 'boolean')) {
    return res.status(400).json({ error: "Invalid format or subtitles option" });
  }
  const id = createJobId();
  const outputPath = path.join(uploadsDir, `clip-${id}.mp4`);
  const job: Job = { id, status: 'processing', filePath: outputPath };
  jobs.set(id, job);

  (async () => {
    let tempCookiesPath: string | null = null;
    try {
      const section = `*${startTime}-${endTime}`;
      
      const prodCookiesPath = '/etc/secrets/cookies.txt';
      if (fs.existsSync(prodCookiesPath)) {
        const cookiesContent = fs.readFileSync(prodCookiesPath, 'utf-8');
        tempCookiesPath = path.join(uploadsDir, `cookies-${id}.txt`);
        fs.writeFileSync(tempCookiesPath, cookiesContent);
      }

      const ytArgs = [
        ...ytDlpToolArgs,
        url,
      ];
      if (formatId) {
        ytArgs.push("-f", formatId);
      } else {
        ytArgs.push("-f", "bv[ext=mp4][vcodec^=avc1][height<=?1080][fps<=?60]+ba[ext=m4a]/best[ext=mp4][vcodec^=avc1][height<=?1080]");
      }
      ytArgs.push(
        "--download-sections",
        section,
        // Decode at the cut boundary instead of retaining video from an earlier
        // keyframe, which can play out of sync with the trimmed audio.
        "--force-keyframes-at-cuts",
        "-o",
        outputPath,
        "--merge-output-format",
        "mp4",
        "--no-check-certificates",
        "--no-warnings",
        "--add-header",
        "referer:youtube.com",
        "--add-header",
        "user-agent:Mozilla/5.0",
        "--verbose"
      );
      if (subtitles) {
        ytArgs.push(
          "--write-subs",
          "--write-auto-subs",
          "--sub-lang",
          "en",
          "--sub-format",
          "vtt"
        );
      }
      if (tempCookiesPath) {
        ytArgs.push("--cookies", tempCookiesPath);
      } else {
        const localCookiesPath = path.join(__dirname, "cookies.txt");
        if (fs.existsSync(localCookiesPath)) {
          ytArgs.push("--cookies", localCookiesPath)
        }
      }

      const info = await readToolJson(ytDlpPath, [
        ...ytArgs, '--skip-download', '--dump-single-json', '--no-write-subs', '--no-write-auto-subs',
      ]);
      const postLive = info.live_status === 'post_live';
      if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
        throw new Error('This video is live or has not started. Wait for the broadcast to end and YouTube to finish processing its recording before clipping.');
      }
      if (typeof info.duration === 'number' && timeToSeconds(endTime) > info.duration) {
        throw new Error('The requested end time exceeds the video duration. Choose a section within the video.');
      }

      const postLiveInputs = postLive ? await preparePostLiveInputs(
        info, timeToSeconds(startTime), timeToSeconds(endTime), outputPath, ffprobePath, readToolJson,
      ) : null;
      // Post-live sections are assembled from timestamped fragments. yt-dlp's
      // ffmpeg section downloader instead opens the final fragment's base URL.
      if (postLive && subtitles) ytArgs.push('--skip-download');
      if (!postLive || subtitles) {
        console.log(`[job ${id}] starting yt-dlp`);
        const yt = spawn(ytDlpPath, ytArgs);
        yt.stdout.resume();
        yt.stderr.on('data', d => console.error(`[job ${id}]`, d.toString()));

        await new Promise<void>((resolve, reject) => {
          yt.on('close', (code, signal) => {
            if (code === 0) {
              resolve();
            } else if (code === null) {
              reject(new Error(`yt-dlp process was killed by signal: ${signal || 'unknown'}`));
            } else {
              reject(new Error(`yt-dlp exited with code ${code}`));
            }
          });
          yt.on('error', reject);
        });
      }

      if (!postLive) await validateClip(outputPath);
      const fastPath = path.join(uploadsDir, `clip-${id}-fast.mp4`);
      const subPath = outputPath.replace(/\.mp4$/, ".en.vtt");
      const subtitlesExist = fs.existsSync(subPath);

      // Adjust subtitle timestamps if subtitles exist
      if (subtitles && subtitlesExist) {
        const adjustedSubPath = path.join(uploadsDir, `clip-${id}-adjusted.vtt`);
        await adjustSubtitleTimestamps(subPath, adjustedSubPath, startTime);
        // Replace the original subtitle file with the adjusted one
        await fs.promises.rename(adjustedSubPath, subPath);
      }

      await new Promise<void>((resolve, reject) => {
        const ffmpegArgs = [
          '-y',
          ...(postLiveInputs || ['-i', outputPath]),
        ];

        if (subtitles && subtitlesExist) {
          console.log(`[job ${id}] burning subtitles from ${subPath}`);
          ffmpegArgs.push(
            '-vf', `subtitles=${subPath}`,
            '-c:v', 'libx264',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-preset', 'ultrafast',  // Faster encoding, less CPU
            '-crf', '28',            // Lower quality but much smaller file
            '-maxrate', '2M',        // Limit bitrate
            '-bufsize', '4M'         // Limit buffer size
          );
        } else {
          // Post-live cuts need decoding at the boundary; ordinary clips are already trimmed.
          ffmpegArgs.push(
            '-c:v', postLive ? 'libx264' : 'copy',
            ...(postLive ? ['-preset', 'fast'] : []),
            '-c:a', 'aac',
            '-b:a', '128k'
          );
        }

        // Move the `faststart` flag and output path outside the conditional so it applies to both modes
        ffmpegArgs.push(
          '-movflags', '+faststart',
          fastPath
        );

        console.log(`[job ${id}] running ffmpeg`, ffmpegArgs.join(' '));
        const ff = spawn(ffmpegPath, ffmpegArgs);
        
        // Add timeout for ffmpeg process
        const ffmpegTimeout = setTimeout(() => {
          console.log(`[job ${id}] ffmpeg timeout reached, killing process`);
          ff.kill('SIGKILL');
        }, 300000); // 5 minutes timeout
        
        ff.stderr.on('data', d => console.error(`[job ${id}] ffmpeg`, d.toString()));
        ff.on('close', (code, signal) => {
          clearTimeout(ffmpegTimeout);
          if (code === 0) {
            resolve();
          } else if (code === null) {
            reject(new Error(`ffmpeg process was killed by signal: ${signal || 'unknown'} - likely due to memory limits on Render`));
          } else {
            reject(new Error(`ffmpeg exited with code ${code}`));
          }
        });
        ff.on('error', (error) => {
          clearTimeout(ffmpegTimeout);
          reject(error);
        });
      });

      await validateClip(fastPath, postLive ? timeToSeconds(endTime) - timeToSeconds(startTime) : undefined);
      await fs.promises.unlink(outputPath).catch(()=>{});
      await fs.promises.rename(fastPath, outputPath);

      if (subtitlesExist) {
        await fs.promises.unlink(subPath).catch(() => {});
      }

      job.status = 'ready';
    } catch (err: unknown) {
      console.error(`[job ${id}] failed`, err);
      const message = err instanceof Error ? err.message : String(err);
      // Remove only this failed job's media and sidecars, including .part files.
      for (const name of await fs.promises.readdir(uploadsDir).catch(() => [])) {
        if (name.startsWith(`clip-${id}.`) || name.startsWith(`clip-${id}-`)) {
          await fs.promises.rm(path.join(uploadsDir, name), { force: true }).catch(() => {});
        }
      }
      job.error = message;
      job.status = 'error';
    } finally {
      for (const name of await fs.promises.readdir(uploadsDir).catch(() => [])) {
        if (name.startsWith(`clip-${id}.mp4-track-`)) {
          await fs.promises.rm(path.join(uploadsDir, name), { force: true }).catch(() => {});
        }
      }
      if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
        fs.unlinkSync(tempCookiesPath);
      }
    }
  })();

  return res.status(202).json({ id });
});

app.get('/api/clip/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json({ status: job.status, error: job.error });
});

app.delete('/api/clip/:id/cleanup', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.json({ success: true });
  if (job.status === 'processing') return res.status(409).json({ error: 'Job still processing' });
  try {
    await fs.promises.rm(job.filePath, { force: true });
    jobs.delete(job.id);
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: 'Could not remove temporary clip' });
  }
});

app.get('/api/clip/:id/file', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'ready') return res.status(409).json({ error: 'Job not ready' });
  return res.download(job.filePath, 'clip.mp4', (error) => {
    if (error && !res.headersSent) res.status(500).json({ error: 'Could not download clip' });
  });
});

app.get("/api/formats", async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: "url is required" });
  }

  let tempCookiesPath: string | null = null;
  try {

    
    const prodCookiesPath = '/etc/secrets/cookies.txt';
    if (fs.existsSync(prodCookiesPath)) {
      const cookiesContent = fs.readFileSync(prodCookiesPath, 'utf-8');
      const jobId = createJobId();
      tempCookiesPath = path.join(uploadsDir, `cookies-${jobId}.txt`);
      fs.writeFileSync(tempCookiesPath, cookiesContent);
    }
    
    const ytArgs = [
      ...ytDlpToolArgs,
      '-j', 
      '--no-warnings',
      '--no-check-certificates',
      '--add-header',
      'referer:youtube.com',
      '--add-header',
      'user-agent:Mozilla/5.0',
      url as string
    ];
    
    if (tempCookiesPath) {
      ytArgs.push("--cookies", tempCookiesPath);
    } else {
      const localCookiesPath = path.join(__dirname, "cookies.txt");
      if (fs.existsSync(localCookiesPath)) {
        ytArgs.push("--cookies", localCookiesPath)
      }
    }
    
    console.log(`[formats] fetching formats for URL: ${url}`);
    const yt = spawn(ytDlpPath, ytArgs);
    
    // Add timeout for yt-dlp process
    const timeout = setTimeout(() => {
      console.log(`[formats] timeout reached, killing yt-dlp process`);
      yt.kill('SIGKILL');
    }, 30000); // 30 second timeout
    
    let jsonData = '';
    yt.stdout.on('data', (data) => {
      jsonData += data.toString();
    });

    let errorData = '';
    yt.stderr.on('data', (data) => {
        errorData += data.toString();
    });

    yt.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
        fs.unlinkSync(tempCookiesPath);
      }
      if (signal === 'SIGKILL') {
        console.error(`[formats] yt-dlp process timed out after 30 seconds`);
        return res.status(500).json({ error: 'Request timed out - video may be too long or unavailable' });
      }
      if (code !== 0) {
        console.error(`[formats] yt-dlp exited with code ${code}`, errorData);
        return res.status(500).json({ error: `yt-dlp exited with code ${code}` });
      }
      
      try {
        const info = JSON.parse(jsonData);
        
        const MAX_PIXELS = 1920 * 1080;
        
        const videoFormats = info.formats
          .filter((f: any) => 
            f.vcodec !== 'none' && 
            f.height && f.width &&
            (f.width * f.height <= MAX_PIXELS) && 
            (f.ext === 'mp4' || f.ext === 'webm')
          )
          .map((f: any) => ({
            format_id: f.format_id,
            label: `${f.height}p${f.fps > 30 ? f.fps : ''}`,
            height: f.height,
            hasAudio: f.acodec !== 'none',
            ext: f.ext
          }))
          .sort((a: any, b: any) => b.height - a.height);
        
        // Remove duplicates based on height and keep the best format for each resolution
        const uniqueFormats = videoFormats.reduce((acc: any[], current: any) => {
          const existing = acc.find((item) => item.label === current.label);
          if (!existing) {
            acc.push(current);
          } else if (current.hasAudio && !existing.hasAudio) {
            // Prefer formats with audio if available
            const index = acc.findIndex((item) => item.label === current.label);
            acc[index] = current;
          }
          return acc;
        }, []);
        
        // If we need to use video-only formats, we'll use format selection that combines with best audio
        const formatsForUser = uniqueFormats.map((f: any) => ({
          format_id: f.hasAudio ? f.format_id : `${f.format_id}+bestaudio`,
          label: f.label
        }));
        
        return res.json({ formats: formatsForUser });
      } catch (e) {
          console.error('[formats] JSON parse error', e);
          return res.status(500).json({ error: 'Failed to parse yt-dlp output'});
      }
    });

    yt.on('error', (err) => {
        clearTimeout(timeout);
        if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
          fs.unlinkSync(tempCookiesPath);
        }
        console.error('[formats] yt-dlp spawn error', err);
        return res.status(500).json({ error: 'Failed to start yt-dlp process' });
    });

  } catch (err: unknown) {
    if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
      fs.unlinkSync(tempCookiesPath);
    }
    console.error(`[formats] failed`, err);
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

app.get('/api/ping', (_req, res) => {
  return res.json({ success: true });
});

app.get("/", (req, res) => res.send("Server is alive!"));

export const server = app.listen(Number(port), '127.0.0.1', () => {
  console.log(`Local clipper running at http://localhost:${port}`);
});
