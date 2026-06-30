# download_video_tiktok_be

Backend Express API for LinkVault social video downloader. Supports authorized TikTok, Facebook, and YouTube downloads streamed to the browser; completed videos are not saved in this backend project.

## Run

```bash
npm install
npm run setup:yt-dlp
npm run dev
```

Default API URL:

```text
http://localhost:8787
```

Optional env vars:

```bash
PORT=8787
CLIENT_ORIGIN=http://localhost:5173
YT_DLP_COOKIES=/absolute/path/to/cookies.txt
YT_DLP_COOKIES_FROM_BROWSER=chrome:Default
```

For YouTube links blocked by datacenter traffic, the frontend can send a
temporary Netscape `cookies.txt` export with the metadata/download request. The
API writes it to a short-lived local temp file for `yt-dlp` and keeps download
session tokens in memory; cookies are not placed in download URLs.
