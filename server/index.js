import express from 'express';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  cleanYtDlpError,
  detectPlatform,
  fetchDirectDownload,
  getYtDlpStatus,
  readMetadata,
  resolveDirectDownload,
  streamDownload,
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

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CLIENT_ORIGIN || 'http://localhost:5173');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    const cookiesBrowser = normalizeCookiesBrowser(req.body?.cookiesBrowser, req.body?.cookiesProfile);
    const metadata = await readMetadata(url, root, { cookiesBrowser });
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
  try {
    const url = assertSupportedUrl(req.body?.url);
    const quality = normalizeQuality(req.body?.quality);
    const cookiesBrowser = normalizeCookiesBrowser(req.body?.cookiesBrowser, req.body?.cookiesProfile);
    await resolveDirectDownload(url, root, { quality, cookiesBrowser });

    res.json({
      ok: true,
      mode: 'direct-proxy',
      url: buildApiUrl(req, '/api/download-direct', {
        url,
        quality,
        cookiesBrowser: req.body?.cookiesBrowser || 'none',
        cookiesProfile: req.body?.cookiesProfile || '',
        title: req.body?.title || 'video',
      }),
      fileName: buildDownloadFileName(url, req.body?.title),
    });
  } catch (error) {
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
    const url = assertSupportedUrl(req.query?.url);
    const quality = normalizeQuality(req.query?.quality);
    const cookiesBrowser = normalizeCookiesBrowser(req.query?.cookiesBrowser, req.query?.cookiesProfile);
    const fileName = buildDownloadFileName(url, req.query?.title);
    const upstream = await fetchDirectDownload({
      url,
      quality,
      cookiesBrowser,
      root,
      signal: req.signal,
    });

    res.status(200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    if (!res.headersSent && error.handled) {
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

function streamYtDlpDownload(req, res) {
  try {
    const url = assertSupportedUrl(req.query?.url);
    const quality = normalizeQuality(req.query?.quality);
    const cookiesBrowser = normalizeCookiesBrowser(req.query?.cookiesBrowser, req.query?.cookiesProfile);
    const fileName = buildDownloadFileName(url, req.query?.title);
    const child = streamDownload({
      url,
      quality,
      cookiesBrowser,
      root,
    });

    let started = false;
    let stderr = '';

    child.stdout.once('data', (chunk) => {
      started = true;
      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.write(chunk);
      child.stdout.pipe(res);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) {
        stderr = stderr.slice(-8000);
      }
    });

    child.on('error', (error) => {
      if (!started && !res.headersSent) {
        res.status(500).json({ message: error.message || 'Could not start download.' });
      } else {
        res.destroy(error);
      }
    });

    child.on('close', (code) => {
      if (started) {
        if (!res.writableEnded) res.end();
        return;
      }

      res.status(code === 0 ? 204 : 422).json({
        message: cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}.`,
      });
    });
  } catch (error) {
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

  return 'best';
}

function normalizeCookiesBrowser(value, profileValue) {
  if (!value || value === 'none') {
    return null;
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
