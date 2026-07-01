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
# Preferred on Render: create Secret File youtube_cookies.txt.
# It is mounted automatically at /etc/secrets/youtube_cookies.txt.
YT_DLP_COOKIES=/absolute/path/to/cookies.txt
YOUTUBE_COOKIES_FILE=/absolute/path/to/cookies.txt
YOUTUBE_COOKIES_TEXT='paste Netscape cookies.txt content here'
YT_DLP_COOKIES_FROM_BROWSER=chrome:Default
YOUTUBE_PO_TOKEN=raw_or_mweb.gvs_token_from_the_same_browser_session
YT_DLP_YOUTUBE_CLIENTS=default,web_safari,mweb
YT_DLP_YOUTUBE_EXTRACTOR_ARGS=youtube:player-client=default,web_safari,mweb
YT_DLP_RETRIES=3
YT_DLP_FRAGMENT_RETRIES=3
YT_DLP_SLEEP_INTERVAL=5
YT_DLP_MAX_SLEEP_INTERVAL=10
YT_DLP_SLEEP_REQUESTS=1
DISABLE_BGUTIL_POT_PROVIDER=0
BGUTIL_POT_PROVIDER_HOME=/absolute/path/to/bgutil-ytdlp-pot-provider/server
YT_DLP_POT_PROVIDER_ARGS=youtubepot-bgutilscript:server_home=/absolute/path/to/server
```

## Render Free cookies

On Render Free, do not rely on a local `cookies.txt` file inside the app
directory. The filesystem is temporary and the service may sleep/restart. Use
one of these persistent options instead:

1. Render Dashboard -> Service -> Environment -> Secret Files -> Add Secret File
2. Name it `youtube_cookies.txt`
3. Paste the fresh Netscape cookies content
4. Render mounts it at `/etc/secrets/youtube_cookies.txt`

The backend checks that path automatically. No extra env var is required. If you
use a different filename, set `YOUTUBE_COOKIES_FILE` or `YT_DLP_COOKIES` to the
mounted path. If Secret Files are not convenient, set `YOUTUBE_COOKIES_TEXT` as
an environment variable with the full cookies content. Do not commit cookies or
tokens to GitHub.

For YouTube requests, the backend defaults to `--retries 3`,
`--fragment-retries 3`, `--sleep-interval 5`, `--max-sleep-interval 10`, and
`--sleep-requests 1`. Set `YT_DLP_SLEEP_INTERVAL=0` and
`YT_DLP_SLEEP_REQUESTS=0` if you need to disable the deliberate wait.

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
