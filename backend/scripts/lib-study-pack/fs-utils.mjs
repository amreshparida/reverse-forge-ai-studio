import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content.endsWith('\n') ? content : content + '\n', 'utf8');
}

export function writeJson(filePath, data) {
  writeText(filePath, JSON.stringify(data, null, 2));
}

export function appendJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  const fd = fs.openSync(filePath, 'a');
  try {
    for (const row of rows) {
      fs.writeSync(fd, JSON.stringify(row) + '\n');
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function sha256File(filePath, maxBytes = Infinity) {
  const hash = crypto.createHash('sha256');
  const st = fs.statSync(filePath);
  if (st.size > maxBytes) {
    // Hash first + last 1MB and size for huge files when capped
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(1024 * 1024, st.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      hash.update(buf);
      hash.update(Buffer.from(`size:${st.size}`));
      return hash.digest('hex') + ':partial';
    } finally {
      fs.closeSync(fd);
    }
  }
  const stream = fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function sha256FileSync(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** APFS clone when available, else recursive copy. */
export function cloneOrCopy(src, dest) {
  ensureDir(path.dirname(dest));
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  const r = spawnSync('cp', ['-cR', src, dest], { encoding: 'utf8' });
  if (r.status !== 0) {
    fs.cpSync(src, dest, { recursive: true, force: true, errorOnExist: false });
  }
}

export function safeRelativeSymlink(targetAbs, linkAbs) {
  ensureDir(path.dirname(linkAbs));
  if (fs.existsSync(linkAbs) || fs.lstatSync(linkAbs, { throwIfNoEntry: false })) {
    try {
      fs.rmSync(linkAbs, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  const rel = path.relative(path.dirname(linkAbs), targetAbs);
  fs.symlinkSync(rel, linkAbs);
}

export function walkFiles(root, { maxDepth = Infinity, onFile } = {}) {
  const out = [];
  function walk(dir, depth) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (ent.isFile()) {
        const rec = { path: full, rel: path.relative(root, full), size: fileSize(full) };
        out.push(rec);
        if (onFile) onFile(rec);
      }
    }
  }
  if (fs.existsSync(root)) walk(root, 0);
  return out;
}

export function countTree(root) {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  const exts = Object.create(null);
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        dirs += 1;
        walk(full);
      } else if (ent.isFile()) {
        files += 1;
        const sz = fileSize(full);
        bytes += sz;
        const ext = path.extname(ent.name).toLowerCase() || '(none)';
        exts[ext] = (exts[ext] || 0) + 1;
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return { files, dirs, bytes, exts };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function redactSensitive(text) {
  if (!text) return text;
  let s = String(text);
  const patterns = [
    /Bearer\s+[A-Za-z0-9\-._~+/=]+/gi,
    /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_%.]+/g,
    /("?(?:authorization|cookie|set-cookie|access_token|refresh_token|eip\.bearer\.token|eip\.refresh\.token|JSESSIONID[^"]*)"?\s*[:=]\s*")([^"]{8,})(")/gi,
    /(JSESSIONID(?:_[A-Z]+)?=)([^;\s]+)/gi,
  ];
  for (const p of patterns) s = s.replace(p, (m, a, b, c) => (c !== undefined ? `${a}[REDACTED]${c}` : '[REDACTED]'));
  return s;
}

export function assertSafeDeleteTarget(destAbs, repoRootAbs) {
  const resolved = path.resolve(destAbs);
  const root = path.resolve(repoRootAbs);
  if (resolved === '/' || resolved === root) {
    throw new Error(`Refusing to delete unsafe path: ${resolved}`);
  }
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Destination outside repo: ${resolved}`);
  }
  const base = path.basename(resolved);
  if (base !== 'Essential-Cloud-Study-Pack') {
    throw new Error(`Refusing to delete unexpected basename: ${base}`);
  }
  const forbidden = ['backend', 'backend/project-output', 'node_modules', '.git'];
  for (const f of forbidden) {
    if (resolved === path.join(root, f) || resolved.endsWith(path.sep + f)) {
      throw new Error(`Refusing to delete forbidden path: ${resolved}`);
    }
  }
}

export function runSqlite(dbPath, sql, { json = false } = {}) {
  const args = ['-readonly', dbPath];
  if (json) args.unshift('-json');
  else args.unshift('-header', '-separator', '\t');
  // sqlite3 CLI: options before db
  const cliArgs = json
    ? ['-readonly', '-json', dbPath, sql]
    : ['-readonly', '-header', '-separator', '\t', dbPath, sql];
  const out = execFileSync('sqlite3', cliArgs, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (json) {
    const t = out.trim();
    if (!t) return [];
    return JSON.parse(t);
  }
  return out;
}
