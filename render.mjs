#!/usr/bin/env node
// Render a video from videos/<name>.html into out/<name>.mp4.
//
//   node render.mjs videos/hello.html            -> out/hello.mp4
//   node render.mjs hello                        -> same thing
//   node render.mjs hello --stills 3             -> out/stills/hello-1.png ... (quick check)
//   node render.mjs hello --fps 60               -> change frame rate (default 30)
//
// A video page must set window.DURATION (seconds), window.SIZE ([w, h]) and
// window.render(t), which draws the exact frame at time t.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const GITHUB_LIMIT_MB = 100;

function parseArgs(argv) {
  const opts = { fps: 30, stills: 0, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stills') opts.stills = parseInt(argv[++i], 10);
    else if (a === '--fps') opts.fps = parseInt(argv[++i], 10);
    else if (!a.startsWith('--') && !opts.input) opts.input = a;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!opts.input) throw new Error('Usage: node render.mjs <video.html|name> [--stills N] [--fps N]');
  if (!(opts.fps > 0)) throw new Error('--fps must be a positive number');
  if (Number.isNaN(opts.stills) || opts.stills < 0) throw new Error('--stills must be a positive number');
  return opts;
}

function resolveVideo(input) {
  const candidates = [input, path.join('videos', input), path.join('videos', input + '.html')];
  const found = candidates.find(p => existsSync(p) && statSync(p).isFile());
  if (!found) throw new Error(`Could not find video "${input}" (looked in ./ and videos/)`);
  return path.resolve(found);
}

async function openVideo(browser, file) {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  // Turn off CSS animations/transitions so only render(t) moves things.
  await page.addStyleTag({
    content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
  });

  if (errors.length) throw new Error(`Error in video page: ${errors[0]}`);

  const info = await page.evaluate(() => ({
    duration: window.DURATION,
    size: window.SIZE,
    hasRender: typeof window.render === 'function',
  }));
  if (!(info.duration > 0)) throw new Error('window.DURATION must be a positive number of seconds');
  if (!Array.isArray(info.size) || info.size.length !== 2) throw new Error('window.SIZE must be [width, height]');
  if (!info.hasRender) throw new Error('window.render(t) is missing');

  const [w, h] = info.size;
  if (w % 2 || h % 2) throw new Error('window.SIZE width and height must be even numbers (needed for MP4)');
  await page.setViewportSize({ width: w, height: h });

  const frameAt = async t => {
    await page.evaluate(t => window.render(t), t);
    if (errors.length) throw new Error(`Error in render(${t.toFixed(3)}): ${errors[0]}`);
    return page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: w, height: h } });
  };

  return { page, duration: info.duration, width: w, height: h, frameAt };
}

function startFfmpeg(outFile, fps) {
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    outFile,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
  });
  const write = buf => new Promise((resolve, reject) => {
    ff.stdin.write(buf, err => (err ? reject(err) : resolve()));
  });
  return { write, finish: () => { ff.stdin.end(); return done; } };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const file = resolveVideo(opts.input);
  const name = path.basename(file, path.extname(file));

  const browser = await chromium.launch();
  try {
    const video = await openVideo(browser, file);
    const totalFrames = Math.round(video.duration * opts.fps);

    if (opts.stills > 0) {
      const dir = path.join('out', 'stills');
      mkdirSync(dir, { recursive: true });
      const last = (totalFrames - 1) / opts.fps;
      for (let k = 0; k < opts.stills; k++) {
        // Evenly spread from the first frame to the last frame
        const t = opts.stills === 1 ? last / 2 : (k * last) / (opts.stills - 1);
        const outPng = path.join(dir, `${name}-${k + 1}.png`);
        const png = await video.frameAt(t);
        writeFileSync(outPng, png);
        console.log(`still ${k + 1}/${opts.stills}  t=${t.toFixed(2)}s  -> ${outPng}`);
      }
      return;
    }

    mkdirSync('out', { recursive: true });
    const outFile = path.join('out', `${name}.mp4`);
    console.log(`Rendering ${name}: ${video.width}x${video.height}, ${video.duration}s, ${opts.fps} fps, ${totalFrames} frames`);

    const ff = startFfmpeg(outFile, opts.fps);
    const started = Date.now();
    for (let i = 0; i < totalFrames; i++) {
      await ff.write(await video.frameAt(i / opts.fps));
      if ((i + 1) % opts.fps === 0 || i === totalFrames - 1) {
        process.stdout.write(`\r  frame ${i + 1}/${totalFrames}`);
      }
    }
    await ff.finish();
    process.stdout.write('\n');

    const mb = statSync(outFile).size / (1024 * 1024);
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${outFile} (${mb.toFixed(2)} MB)`);
    if (mb > GITHUB_LIMIT_MB) {
      console.warn(`WARNING: ${outFile} is over GitHub's ${GITHUB_LIMIT_MB} MB limit. Compress it or use Git LFS before pushing.`);
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
