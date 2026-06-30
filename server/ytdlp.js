import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const supportedHosts = [
  /(^|\.)tiktok\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)fb\.watch$/i,
];
let cachedYtDlpCommand = null;
let cachedYtDlpStatus = null;
let cachedYtDlpStatusAt = 0;
const metadataCache = new Map();
const directDownloadCache = new Map();
const statusCacheTtlMs = 5 * 60 * 1000;
const failedStatusCacheTtlMs = 10 * 1000;
const metadataCacheTtlMs = 10 * 60 * 1000;
const directDownloadCacheTtlMs = 10 * 60 * 1000;

export function detectPlatform(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    if (/tiktok\.com$/i.test(host)) return 'TikTok';
    if (/facebook\.com$/i.test(host) || /fb\.watch$/i.test(host)) return 'Facebook';
  } catch {
    return null;
  }

  return null;
}

export async function getYtDlpStatus(root) {
  const cacheTtl = cachedYtDlpStatus?.available ? statusCacheTtlMs : failedStatusCacheTtlMs;
  if (cachedYtDlpStatus && Date.now() - cachedYtDlpStatusAt < cacheTtl) {
    return cachedYtDlpStatus;
  }

  const command = resolveYtDlp(root);
  if (!command) {
    cachedYtDlpStatus = {
      available: false,
      message: 'yt-dlp is not installed. Run npm run setup:yt-dlp.',
    };
    cachedYtDlpStatusAt = Date.now();
    return cachedYtDlpStatus;
  }

  const vendorVersion = readVendoredYtDlpVersion(root);
  if (vendorVersion) {
    cachedYtDlpStatus = {
      available: true,
      version: vendorVersion,
      runtime: command.label,
    };
    cachedYtDlpStatusAt = Date.now();
    return cachedYtDlpStatus;
  }

  const result = spawnSync(command.cmd, [...command.prefixArgs, '--version'], {
    env: command.env,
    encoding: 'utf8',
    timeout: 15000,
  });

  if (result.status !== 0) {
    cachedYtDlpStatus = {
      available: false,
      message: (result.stderr || result.error?.message || 'yt-dlp could not be started.').trim(),
    };
    cachedYtDlpStatusAt = Date.now();
    return cachedYtDlpStatus;
  }

  cachedYtDlpStatus = {
    available: true,
    version: result.stdout.trim(),
    runtime: command.label,
  };
  cachedYtDlpStatusAt = Date.now();
  return cachedYtDlpStatus;
}

export async function readMetadata(url, root, options = {}) {
  assertKnownHost(url);
  const cacheKey = buildCacheKey('metadata', url, options);
  const cached = readCache(metadataCache, cacheKey, metadataCacheTtlMs);
  if (cached) {
    return cached;
  }

  const json = await runYtDlp(
    [
      ...commonArgs(url, options),
      '--skip-download',
      '--dump-single-json',
      url,
    ],
    {
      root,
      timeoutMs: 90_000,
      maxOutputBytes: 20 * 1024 * 1024,
    },
  );

  let data;
  try {
    data = JSON.parse(json.stdout);
  } catch {
    const error = new Error('yt-dlp returned metadata in an unexpected format.');
    error.status = 502;
    throw error;
  }

  const metadata = {
    id: data.id,
    title: data.title || 'Untitled video',
    uploader: data.uploader || data.channel || data.creator || 'Unknown creator',
    thumbnail: data.thumbnail,
    duration: data.duration,
    webpageUrl: data.webpage_url || url,
    formats: summarizeFormats(data.formats || []),
  };
  writeCache(metadataCache, cacheKey, metadata);
  return metadata;
}

export async function resolveDirectDownload(url, root, options = {}) {
  assertKnownHost(url);
  const quality = options.quality || 'best';
  const cacheKey = buildCacheKey('direct', url, {
    cookiesBrowser: options.cookiesBrowser,
    quality,
  });
  const cached = readCache(directDownloadCache, cacheKey, directDownloadCacheTtlMs);
  if (cached) {
    return cached;
  }

  const result = await runYtDlp(
    [
      ...commonArgs(url, options),
      '--quiet',
      '--no-progress',
      '--format',
      directQualityToFormat(quality),
      '--get-url',
      url,
    ],
    {
      root,
      timeoutMs: 45_000,
      maxOutputBytes: 2 * 1024 * 1024,
    },
  );

  const urls = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));

  if (urls.length !== 1) {
    const error = new Error('Could not resolve a single direct media URL. Falling back to server streaming.');
    error.status = 409;
    error.handled = true;
    throw error;
  }

  const payload = {
    url: urls[0],
    mode: 'direct',
    cachedAt: new Date().toISOString(),
  };
  writeCache(directDownloadCache, cacheKey, payload);
  return payload;
}

export function streamDownload({ url, quality, cookiesBrowser, root }) {
  assertKnownHost(url);

  const command = resolveYtDlp(root);
  if (!command) {
    const error = new Error('yt-dlp is not installed. Run npm run setup:yt-dlp.');
    error.status = 503;
    throw error;
  }

  const args = [
    ...commonArgs(url, { cookiesBrowser }),
    '--quiet',
    '--no-progress',
    '--concurrent-fragments',
    process.env.YT_DLP_CONCURRENT_FRAGMENTS || '8',
    '--format',
    streamQualityToFormat(quality),
    '--output',
    '-',
    url,
  ];

  return spawn(command.cmd, [...command.prefixArgs, ...args], {
    cwd: root,
    env: command.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function startDownload({ url, quality, cookiesBrowser, root, downloadsDir, onUpdate }) {
  assertKnownHost(url);

  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const job = {
    id,
    url,
    platform: detectPlatform(url),
    quality,
    status: 'queued',
    progress: 0,
    message: 'Queued',
    filePath: null,
    fileName: null,
    startedAt,
    completedAt: null,
  };

  const update = (patch) => {
    Object.assign(job, patch);
    onUpdate({ ...job });
  };

  const args = [
    ...commonArgs(url, { cookiesBrowser }),
    '--newline',
    '--merge-output-format',
    'mp4',
    '--paths',
    downloadsDir,
    '--output',
    '%(extractor)s-%(id)s-%(title).80s.%(ext)s',
    '--print',
    'after_move:filepath',
    '--format',
    qualityToFormat(quality),
    url,
  ];

  queueMicrotask(() => {
    update({
      status: 'running',
      message: quality === 'clean'
        ? 'Requesting best clean source stream when available'
        : 'Requesting best available source quality',
    });

    const command = resolveYtDlp(root);
    if (!command) {
      update({
        status: 'error',
        message: 'yt-dlp is not installed. Run npm run setup:yt-dlp.',
        completedAt: new Date().toISOString(),
      });
      return;
    }

    const child = spawn(command.cmd, [...command.prefixArgs, ...args], {
      cwd: root,
      env: command.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let lastLine = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        lastLine = line.trim();
        const percent = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
        if (percent) {
          update({
            progress: Math.min(100, Number(percent[1])),
            message: line.replace(/\s+/g, ' ').trim(),
          });
          continue;
        }

        if (line.includes('/') || line.includes('\\')) {
          updateFilePath(line.trim(), update);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) {
        stderr = stderr.slice(-8000);
      }
    });

    child.on('error', (error) => {
      update({
        status: 'error',
        message: error.message,
        completedAt: new Date().toISOString(),
      });
    });

    child.on('close', (code) => {
      if (code === 0) {
        if (lastLine && !job.filePath) {
          updateFilePath(lastLine, update);
        }

        update({
          status: 'complete',
          progress: 100,
          message: 'Download complete',
          completedAt: new Date().toISOString(),
        });
        return;
      }

      update({
        status: 'error',
        progress: 0,
        message: cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}.`,
        completedAt: new Date().toISOString(),
      });
    });
  });

  return { ...job };
}

function commonArgs(url, options = {}) {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--restrict-filenames',
  ];

  if (detectPlatform(url) === 'TikTok' && process.env.YT_DLP_IMPERSONATE !== '0') {
    args.push('--impersonate', process.env.YT_DLP_IMPERSONATE || 'chrome');
  }

  if (process.env.YT_DLP_COOKIES) {
    args.push('--cookies', process.env.YT_DLP_COOKIES);
  }

  const cookiesBrowser = options.cookiesBrowser || process.env.YT_DLP_COOKIES_FROM_BROWSER;
  if (cookiesBrowser) {
    args.push('--cookies-from-browser', cookiesBrowser);
  }

  return args;
}

function qualityToFormat(quality) {
  if (quality === 'mp4') {
    return 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best';
  }

  if (quality === 'clean') {
    return 'bv*+ba/best';
  }

  return 'bv*+ba/best';
}

function streamQualityToFormat(quality) {
  if (quality === 'mp4') {
    return 'b[ext=mp4]/best[ext=mp4]/best';
  }

  return 'b[ext=mp4]/best';
}

function directQualityToFormat(quality) {
  if (quality === 'best') {
    return 'b[ext=mp4]/best[ext=mp4]/best';
  }

  return streamQualityToFormat(quality);
}

function summarizeFormats(formats) {
  const seen = new Set();
  return formats
    .filter((format) => format.vcodec !== 'none' || format.acodec !== 'none')
    .map((format) => ({
      id: format.format_id,
      ext: format.ext,
      resolution: format.resolution || format.format_note || format.height && `${format.height}p` || 'unknown',
      height: format.height || null,
      fps: format.fps || null,
      vcodec: format.vcodec || null,
      acodec: format.acodec || null,
      filesize: format.filesize || format.filesize_approx || null,
    }))
    .filter((format) => {
      const key = `${format.ext}-${format.resolution}-${format.vcodec}-${format.acodec}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function resolveYtDlp(root) {
  if (cachedYtDlpCommand) {
    return cachedYtDlpCommand;
  }

  if (process.env.YT_DLP_PATH) {
    cachedYtDlpCommand = {
      cmd: process.env.YT_DLP_PATH,
      prefixArgs: [],
      env: process.env,
      label: 'YT_DLP_PATH',
    };
    return cachedYtDlpCommand;
  }

  const vendorPython312 = resolve(root, '.vendor/python312/bin/python3');
  const vendorYtDlpPy312 = resolve(root, '.vendor/yt-dlp-py312/yt_dlp/__main__.py');
  if (existsSync(vendorPython312) && existsSync(vendorYtDlpPy312)) {
    cachedYtDlpCommand = {
      cmd: vendorPython312,
      prefixArgs: ['-m', 'yt_dlp'],
      env: {
        ...process.env,
        PYTHONPATH: resolve(root, '.vendor/yt-dlp-py312'),
        PYTHONNOUSERSITE: '1',
        PYTHONWARNINGS: process.env.PYTHONWARNINGS || 'ignore',
      },
      label: '.vendor/python312 + yt-dlp-py312',
    };
    return cachedYtDlpCommand;
  }

  const vendorBinary = resolve(root, '.vendor/bin/yt-dlp');
  if (existsSync(vendorBinary)) {
    const binaryCommand = {
      cmd: vendorBinary,
      prefixArgs: [],
      env: process.env,
      label: '.vendor/bin/yt-dlp',
    };

    if (canStartYtDlp(binaryCommand)) {
      cachedYtDlpCommand = binaryCommand;
      return cachedYtDlpCommand;
    }
  }

  const vendorDir = resolve(root, '.vendor/python');
  const vendorMain = resolve(vendorDir, 'yt_dlp/__main__.py');
  if (existsSync(vendorMain)) {
    cachedYtDlpCommand = {
      cmd: process.env.PYTHON || 'python3',
      prefixArgs: ['-m', 'yt_dlp'],
      env: {
        ...process.env,
        PYTHONPATH: vendorDir,
        PYTHONNOUSERSITE: '1',
        PYTHONWARNINGS: process.env.PYTHONWARNINGS || 'ignore',
      },
      label: '.vendor/python',
    };
    return cachedYtDlpCommand;
  }

  const pathCommand = {
      cmd: 'yt-dlp',
      prefixArgs: [],
      env: process.env,
      label: 'PATH',
  };
  if (canStartYtDlp(pathCommand)) {
    cachedYtDlpCommand = pathCommand;
    return cachedYtDlpCommand;
  }

  return null;
}

function readVendoredYtDlpVersion(root) {
  const candidates = [
    resolve(root, '.vendor/python/yt_dlp/version.py'),
    resolve(root, '.vendor/yt-dlp-py312/yt_dlp/version.py'),
  ];

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const match = readFileSync(candidate, 'utf8').match(/__version__\s*=\s*['"]([^'"]+)['"]/);
      if (match) return match[1];
    } catch {
      // Fall back to asking the executable.
    }
  }

  return null;
}

function canStartYtDlp(command) {
  const result = spawnSync(command.cmd, [...command.prefixArgs, '--version'], {
    env: command.env,
    encoding: 'utf8',
    timeout: 5000,
  });

  return result.status === 0;
}

function runYtDlp(args, { root, timeoutMs, maxOutputBytes }) {
  const command = resolveYtDlp(root);
  if (!command) {
    const error = new Error('yt-dlp is not installed. Run npm run setup:yt-dlp.');
    error.status = 503;
    throw error;
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command.cmd, [...command.prefixArgs, ...args], {
      cwd: root,
      env: command.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const error = new Error('Timed out while asking yt-dlp for metadata.');
      error.status = 504;
      reject(error);
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > maxOutputBytes) {
        child.kill('SIGTERM');
        const error = new Error('yt-dlp metadata response was too large.');
        error.status = 502;
        reject(error);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }

      const error = new Error(cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}.`);
      error.status = 422;
      error.handled = true;
      reject(error);
    });
  });
}

function buildCacheKey(kind, url, options = {}) {
  return JSON.stringify({
    kind,
    url,
    quality: options.quality || '',
    cookiesBrowser: options.cookiesBrowser || '',
  });
}

function readCache(cache, key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(cache, key, value) {
  if (cache.size > 200) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, {
    createdAt: Date.now(),
    value,
  });
}

function updateFilePath(value, update) {
  const cleaned = value.replace(/^filepath:\s*/i, '').trim();
  if (!cleaned || cleaned.startsWith('[')) return;

  const fileName = cleaned.split(/[\\/]/).pop();
  update({
    filePath: cleaned,
    fileName,
  });
}

export function cleanYtDlpError(stderr) {
  const message = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^ERROR:\s*/i, ''))
    .filter((line) => !line.startsWith('WARNING:'))
    .filter((line) => !line.includes('NotOpenSSLWarning'))
    .filter((line) => !line.includes('warnings.warn('))
    .filter((line) => !line.includes('Deprecated Feature:'))
    .filter((line) => !line.includes('Support for Python version'))
    .slice(-3)
    .join(' ');

  if (/Operation not permitted.*Cookies\.binarycookies/i.test(message)) {
    return 'macOS blocked Safari cookie access. Grant your terminal Full Disk Access in System Settings, or choose a different browser such as Chrome.';
  }

  if (/TikTok.*Unable to extract webpage video data/i.test(message)) {
    return 'TikTok did not expose video data for this request. Use the exact TikTok share URL, confirm the video is public, and try the browser cookies option for the browser where you are logged in.';
  }

  return message;
}

function assertKnownHost(url) {
  const host = new URL(url).hostname;
  if (!supportedHosts.some((pattern) => pattern.test(host))) {
    const error = new Error('Only TikTok and Facebook links are supported.');
    error.status = 400;
    throw error;
  }
}
