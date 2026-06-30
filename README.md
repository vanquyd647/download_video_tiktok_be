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
YT_DLP_YOUTUBE_CLIENTS=default,web_safari,mweb
YT_DLP_YOUTUBE_EXTRACTOR_ARGS=youtube:player-client=default,web_safari,mweb
DISABLE_BGUTIL_POT_PROVIDER=0
BGUTIL_POT_PROVIDER_HOME=/absolute/path/to/bgutil-ytdlp-pot-provider/server
YT_DLP_POT_PROVIDER_ARGS=youtubepot-bgutilscript:server_home=/absolute/path/to/server
```

For YouTube links blocked by datacenter traffic, the frontend can send a
temporary Netscape `cookies.txt` export with the metadata/download request. The
API writes it to a short-lived local temp file for `yt-dlp` and keeps download
session tokens in memory; cookies and optional PO tokens are not placed in
download URLs.

The build also installs the `bgutil-ytdlp-pot-provider` plugin and script
provider so `yt-dlp` can request YouTube GVS PO tokens automatically. If the
automatic provider still fails, paste a matching YouTube GVS PO token from the
same browser session into the optional PO token field. The API accepts either a
raw token or a full `mweb.gvs+TOKEN` / `web.gvs+TOKEN` value and passes the
modern `CLIENT.CONTEXT+TOKEN` form to `yt-dlp`.
