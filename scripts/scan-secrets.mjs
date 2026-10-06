/**
 * Secret scanner.
 *
 * The app repo is PUBLIC. A token, a real dataset, or a stray `.env` committed
 * here is visible to the world and stays in the git history after deletion.
 *
 * Scans the working tree and, when run with `--history`, every commit. Exits
 * non-zero on a finding so CI fails the build.
 *
 *   node scripts/scan-secrets.mjs
 *   node scripts/scan-secrets.mjs --history
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const SCAN_HISTORY = process.argv.includes('--history');

/**
 * Directories that are never published, so finding something in them is not a
 * leak. `.claude` is local agent/tool state — its launch config points at an
 * absolute path on this machine, which the home-directory rule would otherwise
 * flag on every run. It is gitignored; a scanner that fails CI over a file git
 * will not publish is a scanner people learn to ignore.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'coverage', 'playwright-report',
  'test-results', '.vite', 'build', '.claude',
]);

const SKIP_FILES = new Set(['package-lock.json', 'scan-secrets.mjs']);

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|pdf|zip|mp4|wasm)$/i;

/**
 * Patterns worth failing a build over.
 *
 * Each is anchored to a real credential format rather than a loose keyword, so
 * the scanner stays useful instead of being muted after its tenth false alarm.
 */
const PATTERNS = [
  {
    /**
     * A home-directory path, which carries the OS account name.
     *
     * This exists because the scanner once reported "Clean" on a tree that
     * published the author's real name three times — in a committed launch
     * config and twice in the docs — simply because a name is not a credential
     * format. For a repo whose whole design splits a PUBLIC app from a PRIVATE
     * data store, tying the pseudonymous GitHub handle to a real identity is
     * the leak that matters, and it is the one a credential scanner is blind to.
     *
     * Matching the path shape rather than any particular name keeps this
     * precise: there is no legitimate reason for a committed file to contain
     * someone's home directory, so false positives are near zero.
     */
    name: 'home-directory path (leaks the OS account name)',
    re: /(?:[A-Za-z]:[\\/]Users[\\/]|\/home\/|\/Users\/)[A-Za-z0-9._-]{2,}/g,
    // The placeholders the docs legitimately use.
    filter: (m) => !/[\\/](<you>|<user>|<username>|<your-[a-z-]+>|USERNAME|runner|you)$/i.test(m),
  },
  {
    name: 'GitHub fine-grained PAT',
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  },
  {
    name: 'GitHub classic PAT / OAuth / app token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g,
  },
  {
    name: 'AWS access key id',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    name: 'Slack token',
    re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g,
  },
  {
    name: 'Stripe secret key',
    re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g,
  },
  {
    name: 'OpenAI key',
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
  },
  {
    name: 'Private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    name: 'JSON Web Token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    name: 'Hardcoded secret assignment',
    // token = "…" with something long enough to be real, and not an obvious placeholder.
    re: /\b(?:api[_-]?key|secret|password|passwd|token|auth[_-]?token)\s*[:=]\s*['"`]([^'"`\n]{16,})['"`]/gi,
    filter: (match) => {
      const value = (match.match(/['"`]([^'"`\n]{16,})['"`]/) ?? [])[1] ?? '';
      const placeholder =
        /^(your|example|placeholder|xxx+|\*+|changeme|todo|dummy|sample|test|fake|redacted|github_pat_…|<.*>)/i;
      if (placeholder.test(value)) return false;
      // Type declarations and destructuring are not assignments of a value.
      if (/^[A-Za-z]+(\[\])?$/.test(value)) return false;
      return true;
    },
  },
];

/**
 * Example env files are the documented way to show which variables exist, and
 * `.gitignore` explicitly whitelists `.env.example`. Without this exclusion the
 * two rules contradict each other: adding the file the repo tells you to add
 * would fail CI.
 */
const ENV_EXAMPLE = /^\.env\.(example|sample|template)$/;

/** Files that must never be committed to a public repo at all. */
const FORBIDDEN_PATHS = [
  { re: /^\.env(\..+)?$/, why: 'environment file', unless: ENV_EXAMPLE },
  { re: /^data\.json$/, why: 'a real PaisaTrack dataset' },
  { re: /\.pat$/, why: 'personal access token file' },
  { re: /^(id_rsa|id_ed25519)$/, why: 'SSH private key' },
  { re: /\.pem$/, why: 'certificate or private key' },
];

const findings = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    if (SKIP_FILES.has(entry) || BINARY_EXT.test(entry)) continue;
    // A file larger than 2 MB in source is not source.
    if (st.size > 2 * 1024 * 1024) continue;
    scanFile(full);
  }
}

function scanFile(full) {
  const rel = relative(ROOT, full).split(sep).join('/');

  const base = rel.split('/').pop() ?? '';
  for (const { re, why, unless } of FORBIDDEN_PATHS) {
    if (unless && (unless.test(rel) || unless.test(base))) continue;
    if (re.test(rel) || re.test(base)) {
      findings.push({ file: rel, line: 0, what: `forbidden file (${why})` });
      return;
    }
  }

  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    return; // unreadable or binary
  }

  const lines = text.split('\n');
  for (const { name, re, filter } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (filter && !filter(m[0])) continue;
      const line = text.slice(0, m.index).split('\n').length;
      // Show enough context to find the line, with the match itself redacted —
      // a CI log is not a safe place for a secret, including this one.
      const raw = (lines[line - 1] ?? '').trim();
      const hint = raw.replace(m[0], `${m[0].slice(0, 4)}…[redacted, ${m[0].length} chars]`);
      findings.push({ file: rel, line, what: name, hint: hint.slice(0, 80) });
    }
  }
}

function scanHistory() {
  console.log('Scanning git history...\n');
  let log;
  try {
    log = execSync('git log --all --format=%H', { encoding: 'utf8', cwd: ROOT });
  } catch {
    console.log('  No git history to scan (not a repository yet).');
    return;
  }

  const commits = log.trim().split('\n').filter(Boolean);
  if (commits.length === 0) {
    console.log('  No commits yet.');
    return;
  }

  for (const sha of commits) {
    let diff;
    try {
      diff = execSync(`git show --format= --unified=0 ${sha}`, {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        cwd: ROOT,
      });
    } catch {
      continue;
    }

    for (const { name, re, filter } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(diff)) !== null) {
        if (filter && !filter(m[0])) continue;
        findings.push({
          file: `commit ${sha.slice(0, 8)}`,
          line: 0,
          what: `${name} (in history)`,
        });
      }
    }
  }
  console.log(`  Scanned ${commits.length} commit(s).\n`);
}

// ---------------------------------------------------------------------------

console.log('Scanning the working tree for secrets...\n');
walk(ROOT);
if (SCAN_HISTORY) scanHistory();

if (findings.length === 0) {
  console.log('Clean. No secrets, no forbidden files.');
  if (!SCAN_HISTORY && existsSync(join(ROOT, '.git'))) {
    console.log('\nTip: run with --history before making the repo public.');
  }
  process.exit(0);
}

console.error(`FAILED — ${findings.length} finding(s):\n`);
for (const f of findings) {
  console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}`);
  console.error(`    ${f.what}`);
  if (f.hint) console.error(`    near: ${f.hint}`);
  console.error('');
}
console.error('Nothing above is printed in full, deliberately — a CI log is not');
console.error('a safe place for a secret. Rotate anything real, then remove it.');
process.exit(1);
