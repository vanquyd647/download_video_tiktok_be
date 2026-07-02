import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const supportedHosts = [
  /(^|\.)tiktok\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)fb\.watch$/i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtu\.be$/i,
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
const defaultRenderCookiesPath = '/etc/secrets/youtube_cookies.txt';

export function detectPlatform(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    if (/tiktok\.com$/i.test(host)) return 'TikTok';
    if (/facebook\.com$/i.test(host) || /fb\.watch$/i.test(host)) return 'Facebook';
    if (/youtube\.com$/i.test(host) || /youtu\.be$/i.test(host)) return 'YouTube';
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

export function getYoutubePotProviderStatus(root) {
  if (process.env.DISABLE_BGUTIL_POT_PROVIDER === '1') {
    return {
      available: false,
      mode: 'disabled',
    };
  }

  if (process.env.YT_DLP_POT_PROVIDER_ARGS) {
    return {
      available: true,
      mode: 'custom',
    };
  }

  const serverHome = process.env.BGUTIL_POT_PROVIDER_HOME
    || resolve(root, '.vendor/bgutil-ytdlp-pot-provider/server');
  return {
    available: existsSync(serverHome),
    mode: 'bgutil-script',
  };
}

export function getCookiesSourceStatus() {
  const source = resolveCookiesSource();
  if (!source) {
    return {
      available: false,
      mode: 'none',
    };
  }

  return {
    available: true,
    mode: source.mode,
  };
}

export function getYoutubeProxyStatus() {
  const proxy = resolveProxy();
  if (!proxy) {
    return {
      configured: false,
      mode: 'none',
    };
  }

  if (proxy.placeholder) {
    return {
      configured: false,
      mode: 'placeholder',
      message: 'Replace the placeholder with a real proxy URL.',
    };
  }

  return {
    configured: true,
    mode: 'configured',
  };
}

export async function readMetadata(url, root, options = {}) {
  assertKnownHost(url);
  const cacheKey = buildCacheKey('metadata', url, options);
  const cached = readCache(metadataCache, cacheKey, metadataCacheTtlMs);
  if (cached) {
    return cached;
  }

  const common = commonArgs(url, options);
  let json;
  try {
    json = await runYtDlp(
      [
        ...common.args,
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
  } finally {
    common.cleanup();
  }

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
  const resolution = normalizeResolution(options.resolution);
  const cacheKey = buildCacheKey('direct', url, {
    cookiesBrowser: options.cookiesBrowser,
    cookiesText: options.cookiesText,
    poToken: options.poToken,
    quality,
    resolution,
  });
  const cached = readCache(directDownloadCache, cacheKey, directDownloadCacheTtlMs);
  if (cached) {
    return cached;
  }

  const result = await runYtDlpWithFormatFallback({
    url,
    root,
    options,
    format: directQualityToFormat(quality, resolution),
    fallbackFormat: directQualityFallbackFormat(),
    timeoutMs: 45_000,
  });

  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    const error = new Error('yt-dlp returned download data in an unexpected format.');
    error.status = 502;
    throw error;
  }

  const direct = extractDirectDownload(data);
  if (!direct) {
    const error = new Error('Could not resolve a single direct media URL. Falling back to server streaming.');
    error.status = 409;
    error.handled = true;
    throw error;
  }

  const payload = {
    sourceUrl: direct.url,
    headers: direct.headers,
    mode: 'direct-proxy',
    cachedAt: new Date().toISOString(),
  };
  writeCache(directDownloadCache, cacheKey, payload);
  return payload;
}

export async function fetchDirectDownload({ url, quality, resolution, cookiesBrowser, cookiesText, poToken, root, signal }) {
  const direct = await resolveDirectDownload(url, root, { quality, resolution, cookiesBrowser, cookiesText, poToken });
  return fetchResolvedDirectDownload({ direct, signal });
}

export async function fetchResolvedDirectDownload({ direct, signal }) {
  const headers = filterDownloadHeaders(direct.headers);
  const response = await fetch(direct.sourceUrl, {
    headers,
    redirect: 'follow',
    signal,
  });

  if (!response.ok || !response.body) {
    const error = new Error(`Direct media request failed with status ${response.status}.`);
    error.status = response.status || 502;
    error.handled = true;
    throw error;
  }

  return response;
}

export function streamDownload({ url, quality, resolution, cookiesBrowser, cookiesText, poToken, root }) {
  assertKnownHost(url);

  const command = resolveYtDlp(root);
  if (!command) {
    const error = new Error('yt-dlp is not installed. Run npm run setup:yt-dlp.');
    error.status = 503;
    throw error;
  }

  const format = streamQualityToFormat(quality, resolution);
  const args = buildStreamDownloadArgs(url, { cookiesBrowser, cookiesText, poToken }, format);
  const common = args.common;

  const child = spawn(command.cmd, [...command.prefixArgs, ...args.args], {
    cwd: root,
    env: command.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.once('close', common.cleanup);
  child.once('error', common.cleanup);
  return child;
}

function buildStreamDownloadArgs(url, options, format) {
  const common = commonArgs(url, options);
  return {
    common,
    args: [
      ...common.args,
      '--quiet',
      '--no-progress',
      '--concurrent-fragments',
      process.env.YT_DLP_CONCURRENT_FRAGMENTS || '16',
      '--merge-output-format',
      'mp4',
      '--format',
      format,
      '--output',
      '-',
      url,
    ],
  };
}

export function startDownload({ url, quality, cookiesBrowser, cookiesText, poToken, root, downloadsDir, onUpdate }) {
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

  const common = commonArgs(url, { cookiesBrowser, cookiesText, poToken });
  const args = [
    ...common.args,
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
    child.once('close', common.cleanup);
    child.once('error', common.cleanup);

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
  let cleanup = () => {};

  const geoBypassCountry = process.env.YT_DLP_GEO_BYPASS_COUNTRY;
  if (geoBypassCountry) {
    args.push('--geo-bypass-country', geoBypassCountry);
  } else {
    args.push('--geo-bypass');
  }

  const proxy = resolveProxy();
  if (proxy && !proxy.placeholder) {
    args.push('--proxy', proxy.value);
  }

  if (ffmpegPath && existsSync(ffmpegPath)) {
    args.push('--ffmpeg-location', ffmpegPath);
  }

  if (detectPlatform(url) === 'TikTok' && process.env.YT_DLP_IMPERSONATE !== '0') {
    args.push('--impersonate', process.env.YT_DLP_IMPERSONATE || 'chrome');
  }

  if (detectPlatform(url) === 'YouTube') {
    args.push(
      '--retries',
      process.env.YT_DLP_RETRIES || '3',
      '--fragment-retries',
      process.env.YT_DLP_FRAGMENT_RETRIES || '3',
      '--extractor-retries',
      process.env.YT_DLP_EXTRACTOR_RETRIES || '3',
      '--force-ipv4',
    );

    const remoteComponents = process.env.YT_DLP_REMOTE_COMPONENTS || 'ejs:github';
    if (remoteComponents !== '0') {
      args.push('--remote-components', remoteComponents);
    }

    const jsRuntimes = process.env.YT_DLP_JS_RUNTIMES || 'node';
    if (jsRuntimes !== '0') {
      args.push('--js-runtimes', jsRuntimes);
    }

    if (process.env.YT_DLP_SLEEP_INTERVAL !== '0') {
      args.push(
        '--sleep-interval',
        process.env.YT_DLP_SLEEP_INTERVAL || '5',
        '--max-sleep-interval',
        process.env.YT_DLP_MAX_SLEEP_INTERVAL || '10',
      );
    }

    if (process.env.YT_DLP_SLEEP_REQUESTS !== '0') {
      args.push(
        '--sleep-requests',
        process.env.YT_DLP_SLEEP_REQUESTS || '1',
      );
    }
  }

  for (const extractorArgs of buildYoutubeExtractorArgs(url, options)) {
    args.push('--extractor-args', extractorArgs);
  }

  if (options.cookiesText) {
    const tempCookies = writeTempCookies(options.cookiesText);
    args.push('--cookies', tempCookies.path);
    cleanup = tempCookies.cleanup;
  } else {
    const cookieSource = resolveCookiesSource();
    if (cookieSource?.mode === 'env-text') {
      const tempCookies = writeTempCookies(cookieSource.value);
      args.push('--cookies', tempCookies.path);
      cleanup = tempCookies.cleanup;
    } else if (cookieSource?.mode === 'file') {
      const tempCookies = copyTempCookiesFile(cookieSource.value);
      args.push('--cookies', tempCookies.path);
      cleanup = tempCookies.cleanup;
    }

    const cookiesBrowser = options.cookiesBrowser || process.env.YT_DLP_COOKIES_FROM_BROWSER;
    if (!cookieSource && cookiesBrowser) {
      args.push('--cookies-from-browser', cookiesBrowser);
    }
  }

  return { args, cleanup };
}

function qualityToFormat(quality) {
  if (quality === 'mp4') {
    return 'bv*[ext=mp4]+ba[ext=m4a]/bv*[ext=mp4]+ba/b[ext=mp4]/bv*+ba/best/b';
  }

  if (quality === 'clean') {
    return 'bv*+ba/best/b';
  }

  return 'bv*+ba/best/b';
}

function streamQualityToFormat(quality, resolution) {
  const cap = resolutionCapSelector(resolution);
  if (quality === 'mp4') {
    return [
      `bv*[ext=mp4]${cap}+ba[ext=m4a]`,
      `bv*[ext=mp4]${cap}+ba`,
      `b[ext=mp4]${cap}`,
      `best[ext=mp4]${cap}`,
      'bv*[ext=mp4]+ba[ext=m4a]',
      'bv*[ext=mp4]+ba',
      'b[ext=mp4]',
      'best[ext=mp4]',
      'bv*+ba',
      'best',
      'b',
    ].join('/');
  }

  return [
    `bv*${cap}+ba`,
    `best${cap}`,
    'bv*+ba',
    'best',
    'b',
  ].join('/');
}

function directQualityToFormat(quality, resolution) {
  const cap = resolutionCapSelector(resolution);
  if (quality === 'best' || quality === 'clean') {
    return [
      `bv*${cap}+ba`,
      `best${cap}`,
      'bv*+ba',
      'best',
      'b',
    ].join('/');
  }

  return [
    `bv*[ext=mp4]${cap}+ba[ext=m4a]`,
    `bv*[ext=mp4]${cap}+ba`,
    `b[ext=mp4]${cap}`,
    `best[ext=mp4]${cap}`,
    'bv*[ext=mp4]+ba[ext=m4a]',
    'bv*[ext=mp4]+ba',
    'b[ext=mp4]',
    'best[ext=mp4]',
    'best',
    'b',
  ].join('/');
}

function directQualityFallbackFormat() {
  return 'best/b';
}

function normalizeResolution(value) {
  const normalized = String(value || '1080').trim().toLowerCase();
  if (['auto', '2160', '1440', '1080', '720', '480', '360'].includes(normalized)) {
    return normalized;
  }

  return '1080';
}

function resolutionCapSelector(resolution) {
  const normalized = normalizeResolution(resolution);
  if (normalized === 'auto') return '';
  return `[height<=${normalized}]`;
}

function summarizeFormats(formats) {
  const seen = new Set();
  return formats
    .filter((format) => format.vcodec !== 'none' || format.acodec !== 'none')
    .sort((a, b) => {
      const aVideo = a.vcodec && a.vcodec !== 'none' ? 1 : 0;
      const bVideo = b.vcodec && b.vcodec !== 'none' ? 1 : 0;
      return bVideo - aVideo
        || (b.height || 0) - (a.height || 0)
        || (b.fps || 0) - (a.fps || 0)
        || (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0);
    })
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

function extractDirectDownload(data) {
  const requestedDownloads = Array.isArray(data.requested_downloads) ? data.requested_downloads : [];
  if (requestedDownloads.length > 1) {
    return null;
  }

  const candidates = [
    ...requestedDownloads,
    data,
  ];
  const direct = candidates.find((item) => item?.url && /^https?:\/\//i.test(item.url));
  if (!direct) return null;

  return {
    url: direct.url,
    headers: {
      ...(data.http_headers || {}),
      ...(direct.http_headers || {}),
    },
  };
}

function filterDownloadHeaders(headers = {}) {
  const allowed = new Set([
    'accept',
    'accept-language',
    'cookie',
    'origin',
    'referer',
    'user-agent',
  ]);

  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key, value]) => allowed.has(key.toLowerCase()) && typeof value === 'string' && value),
  );
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

async function runYtDlpWithFormatFallback({ url, root, options, format, fallbackFormat, timeoutMs }) {
  const common = commonArgs(url, options);
  try {
    return await runYtDlp(
      [
        ...common.args,
        '--quiet',
        '--no-progress',
        '--format',
        format,
        '--skip-download',
        '--dump-single-json',
        url,
      ],
      {
        root,
        timeoutMs,
        maxOutputBytes: 20 * 1024 * 1024,
      },
    );
  } catch (error) {
    if (!isRequestedFormatUnavailable(error) || !fallbackFormat || fallbackFormat === format) {
      throw error;
    }

    return runYtDlp(
      [
        ...common.args,
        '--quiet',
        '--no-progress',
        '--format',
        fallbackFormat,
        '--skip-download',
        '--dump-single-json',
        url,
      ],
      {
        root,
        timeoutMs,
        maxOutputBytes: 20 * 1024 * 1024,
      },
    );
  } finally {
    common.cleanup();
  }
}

function isRequestedFormatUnavailable(error) {
  return /Requested format is not available|Use --list-formats/i.test(error?.message || '');
}

function buildCacheKey(kind, url, options = {}) {
  return JSON.stringify({
    kind,
    url,
    quality: options.quality || '',
    resolution: options.resolution || '',
    cookiesBrowser: options.cookiesBrowser || '',
    cookiesTextHash: options.cookiesText ? hashText(options.cookiesText) : '',
    poTokenHash: options.poToken ? hashText(options.poToken) : '',
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

function writeTempCookies(cookiesText) {
  const dir = mkdtempSync(join(tmpdir(), 'linkvault-cookies-'));
  const path = join(dir, 'cookies.txt');
  writeFileSync(path, normalizeCookiesText(cookiesText), { mode: 0o600 });
  return {
    path,
    cleanup: once(() => rmSync(dir, { recursive: true, force: true })),
  };
}

function copyTempCookiesFile(sourcePath) {
  return writeTempCookies(readFileSync(sourcePath, 'utf8'));
}

function normalizeCookiesText(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trimEnd() + '\n';
}

function hashText(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function once(fn) {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

function buildYoutubeExtractorArgs(url, options = {}) {
  if (detectPlatform(url) !== 'YouTube') return [];

  if (process.env.YT_DLP_YOUTUBE_EXTRACTOR_ARGS) {
    return [process.env.YT_DLP_YOUTUBE_EXTRACTOR_ARGS];
  }

  const clients = sanitizeYoutubeClients(
    process.env.YT_DLP_YOUTUBE_CLIENTS || 'tv,tv_simply,web_safari,mweb,web',
  );
  const parts = [`player-client=${clients}`];

  const poToken = options.poToken || process.env.YOUTUBE_PO_TOKEN;
  if (poToken) {
    parts.push(`po_token=${buildPoTokenArg(clients, poToken)}`);
  }

  return [
    `youtube:${parts.join(';')}`,
    ...buildYoutubePotProviderArgs(),
  ];
}

function buildYoutubePotProviderArgs() {
  if (process.env.DISABLE_BGUTIL_POT_PROVIDER === '1') return [];

  if (process.env.YT_DLP_POT_PROVIDER_ARGS) {
    return [process.env.YT_DLP_POT_PROVIDER_ARGS];
  }

  const serverHome = process.env.BGUTIL_POT_PROVIDER_HOME
    || resolve(process.cwd(), '.vendor/bgutil-ytdlp-pot-provider/server');
  if (!existsSync(serverHome)) return [];

  return [`youtubepot-bgutilscript:server_home=${serverHome}`];
}

function sanitizeYoutubeClients(value) {
  const allowed = new Set([
    'default',
    'mweb',
    'web',
    'web_safari',
    'web_embedded',
    'web_music',
    'tv',
    'tv_simply',
  ]);
  const clients = String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => allowed.has(item));
  return (clients.length ? clients : ['default', 'web_safari', 'mweb']).join(',');
}

function buildPoTokenArg(clients, token) {
  const cleanedToken = String(token || '').trim();
  if (!cleanedToken) return '';

  if (looksLikePoTokenSpec(cleanedToken)) {
    return cleanedToken
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .join(',');
  }

  const contexts = ['gvs'];
  return clients
    .split(',')
    .filter((client) => client && client !== 'default')
    .flatMap((client) => contexts.map((context) => `${client}.${context}+${cleanedToken}`))
    .join(',');
}

function resolveCookiesSource() {
  const envText = process.env.YOUTUBE_COOKIES_TEXT || process.env.YT_DLP_COOKIES_TEXT;
  if (envText?.trim()) {
    return {
      mode: 'env-text',
      value: envText,
    };
  }

  const filePath = process.env.YT_DLP_COOKIES
    || process.env.YOUTUBE_COOKIES_FILE
    || defaultRenderCookiesPath;
  if (filePath && existsSync(filePath)) {
    return {
      mode: 'file',
      value: filePath,
    };
  }

  return null;
}

function resolveProxy() {
  const value = process.env.YT_DLP_PROXY?.trim();
  if (!value) return null;

  return {
    value,
    placeholder: isPlaceholderProxy(value),
  };
}

function isPlaceholderProxy(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname === 'host'
      || parsed.port === 'port'
      || parsed.username === 'user'
      || parsed.password === 'password';
  } catch {
    return true;
  }
}

function looksLikePoTokenSpec(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .every((item) => /^[a-z_]+\.(?:gvs|player|subs)\+.+$/i.test(item));
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

  if (/could not find .*cookies database|could not find .*cookies/i.test(message)) {
    return 'This hosted API cannot read browser cookies from your computer. Paste an exported YouTube cookies.txt file instead of choosing Chrome/Safari/Firefox browser cookies.';
  }

  if (/TikTok.*Unable to extract webpage video data/i.test(message)) {
    return 'TikTok did not expose video data for this request. Use the exact TikTok share URL, confirm the video is public, and try the browser cookies option for the browser where you are logged in.';
  }

  if (/YouTube.*Sign in to confirm|confirm you.?re not a bot|HTTP Error 403|PO Token|potoken/i.test(message)) {
    return 'YouTube blocked this request. Try these steps: 1) Paste fresh YouTube cookies.txt exported from a logged-in browser. 2) If it still fails, add a YouTube PO token from the same browser session. 3) Set YT_DLP_PROXY to a residential proxy.';
  }

  if (/not made this video available in your country|video is not available.*your country|geo.?restrict/i.test(message)) {
    return 'This video is geo-restricted and not available from the server\'s location. Set the YT_DLP_PROXY environment variable to a proxy in the allowed country (e.g. a Vietnamese proxy) to bypass this restriction.';
  }

  return message;
}

function assertKnownHost(url) {
  const host = new URL(url).hostname;
  if (!supportedHosts.some((pattern) => pattern.test(host))) {
    const error = new Error('Only TikTok, Facebook, and YouTube links are supported.');
    error.status = 400;
    throw error;
  }
}
