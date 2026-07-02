import express from 'express';
import { existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  detectPlatform,
  downloadToTempFile,
  fetchDirectDownload,
  fetchResolvedDirectDownload,
  getCookiesSourceStatus,
  getYoutubeProxyStatus,
  getYtDlpStatus,
  getYoutubePotProviderStatus,
  readMetadata,
  resolveDirectDownload,
} from './ytdlp.js';
import {
  sendFeedbackMail,
  validateFeedback,
} from './feedback.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const port = Number(process.env.PORT || 8787);
const app = express();
const feedbackRateLimit = new Map();
const downloadSessions = new Map();
const downloadSessionTtlMs = 10 * 60 * 1000;

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CLIENT_ORIGIN || 'http://localhost:5173');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

app.get('/api/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/health', async (_req, res) => {
  const ytDlp = await getYtDlpStatus(root);
  res.json({
    ok: true,
    ytDlp,
    youtubePotProvider: getYoutubePotProviderStatus(root),
    cookiesSource: getCookiesSourceStatus(),
    youtubeProxy: getYoutubeProxyStatus(),
    hostedRuntime: isHostedRuntime(),
    browserCookiesAvailable: !isHostedRuntime(),
    saveMode: 'browser',
  });
});

app.get('/api/browser-profiles', (_req, res) => {
  res.json({
    profiles: listBrowserProfiles(),
  });
});

app.post('/api/feedback', async (req, res) => {
  try {
    enforceFeedbackRateLimit(getClientIp(req));
    const feedback = validateFeedback(req.body);
    await sendFeedbackMail(feedback, {
      ip: getClientIp(req),
      userAgent: req.get('user-agent'),
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 500).json({
      message: error.message || 'Could not send feedback.',
    });
  }
});

app.post('/api/metadata', async (req, res) => {
  try {
    const url = assertSupportedUrl(req.body?.url);
    const cookieOptions = normalizeCookieOptions(req.body);
    const metadata = await readMetadata(url, root, cookieOptions);
    res.json({
      ok: true,
      ...metadata,
      platform: detectPlatform(url),
    });
  } catch (error) {
    if (error.handled) {
      res.json({
        ok: false,
        message: error.message || 'Could not read video metadata.',
      });
      return;
    }

    res.status(error.status || 500).json({
      message: error.message || 'Could not read video metadata.',
    });
  }
});

app.post('/api/download-url', async (req, res) => {
  let url;
  let quality;
  let resolution;
  let cookieOptions;
  let fileName;
  try {
    url = assertSupportedUrl(req.body?.url);
    quality = normalizeQuality(req.body?.quality);
    resolution = normalizeResolution(req.body?.resolution);
    cookieOptions = normalizeCookieOptions(req.body);
    fileName = buildDownloadFileName(url, req.body?.title);
    const direct = await resolveDirectDownload(url, root, { quality, resolution, ...cookieOptions });

    if (hasPrivateDownloadOptions(cookieOptions)) {
      const token = createDownloadSession({
        type: 'direct',
        direct,
        fileName,
      });
      res.json({
        ok: true,
        mode: 'direct-session',
        url: buildApiUrl(req, '/api/download-direct', { token }),
        fileName,
      });
      return;
    }

    res.json({
      ok: true,
      mode: 'direct-proxy',
      url: buildApiUrl(req, '/api/download-direct', {
        url,
        quality,
        resolution,
        cookiesBrowser: req.body?.cookiesBrowser || 'none',
        cookiesProfile: req.body?.cookiesProfile || '',
        title: req.body?.title || 'video',
      }),
      fileName,
    });
  } catch (error) {
    if (error.handled && hasPrivateDownloadOptions(cookieOptions) && url) {
      const token = createDownloadSession({
        type: 'stream',
        url,
        quality,
        resolution,
        cookieOptions,
        fileName,
      });
      res.json({
        ok: true,
        mode: 'stream-session',
        url: buildApiUrl(req, '/api/download-local', { token }),
        fileName,
        message: error.message || 'Using authenticated streaming download.',
      });
      return;
    }

    if (error.handled) {
      res.json({
        ok: false,
        fallback: 'proxy',
        message: error.message || 'Could not resolve a direct download URL.',
      });
      return;
    }

    res.status(error.status || 500).json({
      message: error.message || 'Could not resolve a direct download URL.',
    });
  }
});

app.get('/api/download-local', (req, res) => {
  streamYtDlpDownload(req, res);
});

app.get('/api/download-direct', async (req, res) => {
  try {
    const tokenSession = readDownloadSession(req.query?.token, 'direct');
    if (tokenSession) {
      const upstream = await fetchResolvedDirectDownload({
        direct: tokenSession.direct,
        signal: req.signal,
      });
      sendUpstreamDownload(res, upstream, tokenSession.fileName);
      return;
    }

    const url = assertSupportedUrl(req.query?.url);
    const quality = normalizeQuality(req.query?.quality);
    const resolution = normalizeResolution(req.query?.resolution);
    const cookiesBrowser = normalizeCookiesBrowser(req.query?.cookiesBrowser, req.query?.cookiesProfile);
    const fileName = buildDownloadFileName(url, req.query?.title);
    const upstream = await fetchDirectDownload({
      url,
      quality,
      resolution,
      cookiesBrowser,
      root,
      signal: req.signal,
    });

    sendUpstreamDownload(res, upstream, fileName);
  } catch (error) {
    if (!res.headersSent && error.handled && !req.query?.token) {
      streamYtDlpDownload(req, res);
      return;
    }

    if (!res.headersSent) {
      res.status(error.status || 500).json({
        message: error.message || 'Could not start fast download.',
      });
    } else {
      res.destroy(error);
    }
  }
});

async function streamYtDlpDownload(req, res) {
  let tempDownload;
  try {
    const tokenSession = readDownloadSession(req.query?.token, 'stream');
    const url = tokenSession?.url || assertSupportedUrl(req.query?.url);
    const quality = tokenSession?.quality || normalizeQuality(req.query?.quality);
    const resolution = tokenSession?.resolution || normalizeResolution(req.query?.resolution);
    const cookieOptions = tokenSession?.cookieOptions || {
      cookiesBrowser: normalizeCookiesBrowser(req.query?.cookiesBrowser, req.query?.cookiesProfile),
    };
    const fileName = tokenSession?.fileName || buildDownloadFileName(url, req.query?.title);
    tempDownload = await downloadToTempFile({
      url,
      quality,
      resolution,
      ...cookieOptions,
      root,
    });

    res.download(tempDownload.filePath, fileName, (error) => {
      tempDownload.cleanup();
      tempDownload = null;
      if (error && !res.headersSent) {
        res.status(500).json({ message: error.message || 'Could not send download.' });
      }
    });
  } catch (error) {
    tempDownload?.cleanup();
    res.status(error.status || 500).json({
      message: error.message || 'Could not start download.',
    });
  }
}

app.use((_req, res) => {
  res.status(404).json({ message: 'Route not found.' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`LinkVault API running on http://localhost:${port}`);
});

function assertSupportedUrl(value) {
  if (!value || typeof value !== 'string') {
    const error = new Error('Paste a TikTok, Facebook, or YouTube video link first.');
    error.status = 400;
    throw error;
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    const error = new Error('That does not look like a valid URL.');
    error.status = 400;
    throw error;
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || !detectPlatform(parsed.href)) {
    const error = new Error('Only TikTok, Facebook, and YouTube video links are supported.');
    error.status = 400;
    throw error;
  }

  return parsed.href;
}

function normalizeQuality(value) {
  if (['best', 'mp4', 'clean'].includes(value)) {
    return value;
  }

  return 'mp4';
}

function normalizeResolution(value) {
  const normalized = String(value || '1080').trim().toLowerCase();
  if (['auto', '2160', '1440', '1080', '720', '480', '360'].includes(normalized)) {
    return normalized;
  }

  return '1080';
}

function normalizeCookiesBrowser(value, profileValue) {
  if (!value || value === 'none') {
    return null;
  }

  if (isHostedRuntime()) {
    const error = new Error('Hosted Render API cannot read Chrome/Safari/Firefox cookies from your computer. Paste an exported YouTube cookies.txt file instead.');
    error.status = 400;
    throw error;
  }

  const allowed = new Set(['chrome', 'chromium', 'edge', 'firefox', 'safari', 'brave', 'vivaldi', 'opera']);
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.has(normalized)) {
    const error = new Error('Unsupported browser cookies option.');
    error.status = 400;
    throw error;
  }

  const profile = String(profileValue || '').trim();
  if (!profile) {
    return normalized;
  }

  if (!/^[\w .@()/-]{1,120}$/.test(profile)) {
    const error = new Error('Unsupported browser profile option.');
    error.status = 400;
    throw error;
  }

  return `${normalized}:${profile}`;
}

function normalizeCookieOptions(source) {
  const cookiesText = normalizeCookiesText(source?.cookiesText);
  const poToken = normalizePoToken(source?.poToken);
  if (cookiesText) {
    return {
      cookiesBrowser: null,
      cookiesText,
      poToken,
    };
  }

  return {
    cookiesBrowser: normalizeCookiesBrowser(source?.cookiesBrowser, source?.cookiesProfile),
    poToken,
  };
}

function hasPrivateDownloadOptions(cookieOptions) {
  return Boolean(cookieOptions?.cookiesText || cookieOptions?.poToken);
}

function normalizeCookiesText(value) {
  if (!value) return null;

  const text = String(value).replace(/\r\n?/g, '\n').trim();
  if (!text) return null;
  if (text.length > 300_000) {
    const error = new Error('Cookies file is too large. Export only YouTube cookies and try again.');
    error.status = 400;
    throw error;
  }

  const meaningfulLines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const looksLikeCookiesTxt = meaningfulLines.some((line) => line.split('\t').length >= 7);
  const hasRelevantHost = meaningfulLines.some((line) => /(^|\.)youtube\.com|(^|\.)google\.com/i.test(line));
  if (!looksLikeCookiesTxt || !hasRelevantHost) {
    const error = new Error('Paste a Netscape cookies.txt export that includes YouTube or Google cookies.');
    error.status = 400;
    throw error;
  }

  return `${text}\n`;
}

function normalizePoToken(value) {
  if (!value) return null;

  const token = String(value).trim();
  if (!token) return null;
  if (token.length > 4096 || !/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
    const error = new Error('YouTube PO token format is not valid.');
    error.status = 400;
    throw error;
  }

  return token;
}

function createDownloadSession(payload) {
  sweepDownloadSessions();
  const token = randomUUID();
  downloadSessions.set(token, {
    ...payload,
    expiresAt: Date.now() + downloadSessionTtlMs,
  });
  return token;
}

function readDownloadSession(value, type) {
  if (!value) return null;
  const token = String(value);
  const session = downloadSessions.get(token);
  if (!session) {
    const error = new Error('Download session expired. Inspect the link again and retry.');
    error.status = 410;
    throw error;
  }

  if (session.expiresAt < Date.now() || session.type !== type) {
    downloadSessions.delete(token);
    const error = new Error('Download session expired. Inspect the link again and retry.');
    error.status = 410;
    throw error;
  }

  return session;
}

function sweepDownloadSessions() {
  const now = Date.now();
  for (const [token, session] of downloadSessions) {
    if (session.expiresAt < now) {
      downloadSessions.delete(token);
    }
  }
}

function sendUpstreamDownload(res, upstream, fileName) {
  res.status(200);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) {
    res.setHeader('Content-Length', contentLength);
  }
  Readable.fromWeb(upstream.body).pipe(res);
}

function buildDownloadFileName(url, title) {
  const platform = detectPlatform(url) || 'video';
  const videoId = new URL(url).pathname.split('/').filter(Boolean).pop() || 'download';
  const safeTitle = sanitizeFilePart(title || videoId).slice(0, 80);
  return `${sanitizeFilePart(platform)}-${videoId}-${safeTitle}.mp4`;
}

function buildApiUrl(req, pathname, params) {
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  const base = `${protocol}://${req.get('host')}`;
  const apiUrl = new URL(pathname, base);
  for (const [key, value] of Object.entries(params)) {
    apiUrl.searchParams.set(key, value);
  }
  return apiUrl.href;
}

function sanitizeFilePart(value) {
  return String(value || 'video')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'video';
}

function listBrowserProfiles() {
  const home = homedir();
  const locations = {
    chrome: join(home, 'Library/Application Support/Google/Chrome'),
    brave: join(home, 'Library/Application Support/BraveSoftware/Brave-Browser'),
    edge: join(home, 'Library/Application Support/Microsoft Edge'),
    chromium: join(home, 'Library/Application Support/Chromium'),
    vivaldi: join(home, 'Library/Application Support/Vivaldi'),
    opera: join(home, 'Library/Application Support/com.operasoftware.Opera'),
    firefox: join(home, 'Library/Application Support/Firefox/Profiles'),
  };

  return Object.fromEntries(
    Object.entries(locations).map(([browser, basePath]) => [browser, readProfileDirs(basePath)]),
  );
}

function readProfileDirs(basePath) {
  try {
    if (!existsSync(basePath)) return [];
    return readdirSync(basePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        const hasPreferences = existsSync(join(basePath, name, 'Preferences'));
        const isFirefoxProfile = existsSync(join(basePath, name, 'cookies.sqlite'));
        return hasPreferences || isFirefoxProfile;
      })
      .filter((name) => name !== 'System Profile')
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function getClientIp(req) {
  return String(req.get('x-forwarded-for') || req.ip || 'unknown').split(',')[0].trim();
}

function isHostedRuntime() {
  return Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
}

function enforceFeedbackRateLimit(ip) {
  const now = Date.now();
  const key = ip || 'unknown';
  const windowMs = 15 * 60 * 1000;
  const maxRequests = 5;
  const entry = feedbackRateLimit.get(key) || { count: 0, resetAt: now + windowMs };

  if (entry.resetAt < now) {
    feedbackRateLimit.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (entry.count >= maxRequests) {
    const error = new Error('Too many feedback messages. Please try again later.');
    error.status = 429;
    throw error;
  }

  entry.count += 1;
  feedbackRateLimit.set(key, entry);
}
