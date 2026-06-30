import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PYTHON_STANDALONE_URL =
  'https://github.com/astral-sh/python-build-standalone/releases/download/20260623/cpython-3.12.13%2B20260623-aarch64-apple-darwin-install_only_stripped.tar.gz';
const YT_DLP_SOURCE_URL =
  'yt-dlp[default,curl-cffi] @ https://github.com/yt-dlp/yt-dlp/archive/refs/tags/2026.06.09.zip';
const POT_PROVIDER_PACKAGE = 'bgutil-ytdlp-pot-provider==1.3.1';
const BGUTIL_PROVIDER_REPO = 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git';
const BGUTIL_PROVIDER_VERSION = '1.3.1';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const vendorRoot = resolve(root, '.vendor');
const python312Dir = resolve(vendorRoot, 'python312');
const python312 = resolve(python312Dir, 'bin/python3');
const ytDlpPy312Dir = resolve(vendorRoot, 'yt-dlp-py312');
const bgutilProviderDir = resolve(vendorRoot, 'bgutil-ytdlp-pot-provider');
const bgutilServerDir = resolve(bgutilProviderDir, 'server');

if (process.platform === 'darwin' && process.arch === 'arm64') {
  installPortablePythonYtDlp();
} else {
  installSystemPythonYtDlp();
}

function installPortablePythonYtDlp() {
  mkdirSync(vendorRoot, { recursive: true });

  if (!existsSync(python312)) {
    const archivePath = resolve(vendorRoot, 'python312.tar.gz');
    rmSync(python312Dir, { recursive: true, force: true });

    run('curl', [
      '-L',
      '--fail',
      '--show-error',
      '--output',
      archivePath,
      PYTHON_STANDALONE_URL,
    ], 'Failed to download portable Python 3.12.');

    mkdirSync(python312Dir, { recursive: true });
    run('tar', [
      '-xzf',
      archivePath,
      '-C',
      python312Dir,
      '--strip-components=1',
    ], 'Failed to extract portable Python 3.12.');

    rmSync(archivePath, { force: true });
  }

  rmSync(ytDlpPy312Dir, { recursive: true, force: true });
  run(python312, [
    '-m',
    'pip',
    'install',
    '--upgrade',
    '--target',
    ytDlpPy312Dir,
    YT_DLP_SOURCE_URL,
    POT_PROVIDER_PACKAGE,
  ], 'Failed to install yt-dlp with portable Python 3.12.');

  installBgutilProvider();

  const verify = spawnSync(
    python312,
    ['-m', 'yt_dlp', '--version'],
    {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: ytDlpPy312Dir,
        PYTHONNOUSERSITE: '1',
        PYTHONWARNINGS: process.env.PYTHONWARNINGS || 'ignore',
      },
      encoding: 'utf8',
    },
  );

  if (verify.status !== 0) {
    console.error(verify.stderr || verify.error?.message || 'yt-dlp verification failed.');
    process.exit(verify.status ?? 1);
  }

  console.log(`\nyt-dlp ${verify.stdout.trim()} installed into ${ytDlpPy312Dir}`);
}

function installSystemPythonYtDlp() {
  const vendorDir = resolve(vendorRoot, 'python');
  mkdirSync(vendorDir, { recursive: true });

  const python = process.env.PYTHON || 'python3';
  run(python, [
    '-m',
    'pip',
    'install',
    '--upgrade',
    '--target',
    vendorDir,
    'yt-dlp[default,curl-cffi]',
    POT_PROVIDER_PACKAGE,
  ], 'Failed to install yt-dlp. Check Python/pip and network access, then retry.');

  installBgutilProvider();

  const verify = spawnSync(
    python,
    ['-c', 'import yt_dlp; print(yt_dlp.version.__version__)'],
    {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: vendorDir,
        PYTHONNOUSERSITE: '1',
        PYTHONWARNINGS: process.env.PYTHONWARNINGS || 'ignore',
      },
      encoding: 'utf8',
    },
  );

  if (verify.status !== 0) {
    console.error(verify.stderr || verify.error?.message || 'yt-dlp verification failed.');
    process.exit(verify.status ?? 1);
  }

  console.log(`\nyt-dlp ${verify.stdout.trim()} installed into ${vendorDir}`);
}

function installBgutilProvider() {
  if (process.env.DISABLE_BGUTIL_POT_PROVIDER === '1') {
    console.log('\nSkipping bgutil PO token provider install.');
    return;
  }

  rmSync(bgutilProviderDir, { recursive: true, force: true });
  run('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    BGUTIL_PROVIDER_VERSION,
    BGUTIL_PROVIDER_REPO,
    bgutilProviderDir,
  ], 'Failed to download bgutil PO token provider.');

  run('npm', ['ci'], 'Failed to install bgutil PO token provider dependencies.', {
    cwd: bgutilServerDir,
  });
  run('npx', ['tsc'], 'Failed to build bgutil PO token provider.', {
    cwd: bgutilServerDir,
  });

  console.log(`\nbgutil PO token provider installed into ${bgutilProviderDir}`);
}

function run(command, args, failureMessage, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: {
      ...process.env,
      PYTHONNOUSERSITE: '1',
      PYTHONWARNINGS: process.env.PYTHONWARNINGS || 'ignore',
    },
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.error(`\n${failureMessage}`);
    process.exit(result.status ?? 1);
  }
}
