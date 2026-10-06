// EPS website server - zero dependencies. Run: node server.js
//
// Environment variables (all optional locally, see README.md for hosting):
//   PORT                  port to listen on (default 3000)
//   DATA_DIR              folder for data.json and uploads/ (default: this folder). Point it at a persistent disk when hosting.
//   ADMIN_PASSWORD_HASH   hashed admin password, made with: node hash-password.js   (recommended when hosting)
//   ADMIN_PASSWORD        plain admin password (simpler, less safe than the hash)
//   NODE_ENV=production   refuses to start without a password set, instead of generating one
//   TRUST_PROXY=1         set when behind a hosting proxy so login lockouts work per visitor
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || DIR);
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PW_FILE = path.join(DATA_DIR, '.admin-password');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PROD = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// ---- first start: create the data folder, seeding it from the files shipped with the code ----
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  const seed = path.join(DIR, 'data.json');
  if (DATA_DIR !== DIR && fs.existsSync(seed)) {
    fs.copyFileSync(seed, DATA_FILE);
    const seedUploads = path.join(DIR, 'uploads');
    if (fs.existsSync(seedUploads)) for (const f of fs.readdirSync(seedUploads)) fs.copyFileSync(path.join(seedUploads, f), path.join(UPLOAD_DIR, f));
    console.log('Seeded', DATA_DIR, 'from the bundled data.json and uploads/');
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ teams: [], matches: [], players: [], staff: [], gallery: [] }, null, 2));
  }
}

const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const LOGO_RE = /^\/uploads\/[a-f0-9]{16}\.(png|jpg|webp|gif)$/;
const uploadFile = urlPath => path.join(DATA_DIR, urlPath);
// detect image type from magic bytes (never trust the client's content-type)
const sniff = b => {
  if (b.length > 12 && b.slice(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.slice(0, 6).toString())) return 'gif';
  return null;
};

// ---- admin password ----
const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const scrypt = (pw, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? reject(e) : resolve(k)));

const HASH = (process.env.ADMIN_PASSWORD_HASH || '').trim();
let PASSWORD = process.env.ADMIN_PASSWORD;
if (HASH && !/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(HASH)) {
  console.error('ADMIN_PASSWORD_HASH is not valid. Create one with: node hash-password.js');
  process.exit(1);
}
if (!HASH && !PASSWORD) {
  if (PROD) {
    console.error('No admin password set. Set ADMIN_PASSWORD_HASH (recommended) or ADMIN_PASSWORD, then start again.');
    process.exit(1);
  }
  if (!fs.existsSync(PW_FILE)) {
    fs.writeFileSync(PW_FILE, crypto.randomBytes(9).toString('base64url'));
    console.log('Generated a new admin password, see the file .admin-password');
  }
  PASSWORD = fs.readFileSync(PW_FILE, 'utf8').trim();
}
async function checkPassword(pw) {
  if (HASH) {
    const [, salt, hash] = HASH.split('$');
    const got = await scrypt(pw, Buffer.from(salt, 'hex'));
    return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
  }
  return safeEq(pw, PASSWORD);
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/admin.html': ['admin.html', 'text/html; charset=utf-8'],
  '/logo.png': ['logo.png', 'image/png'],
  '/favicon.ico': ['logo.png', 'image/png'],
  '/robots.txt': ['robots.txt', 'text/plain; charset=utf-8'],
};

const sessions = new Map(); // token -> expiry
const SESSION_MS = 12 * 3600 * 1000;
const fails = new Map(); // ip -> {n, until}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
  for (const [ip, f] of fails) if (f.until < now && f.n === 0) fails.delete(ip);
}, 10 * 60 * 1000).unref();

const clientIp = req => {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // the address the proxy itself saw
  }
  return req.socket.remoteAddress;
};
const getCookie = (req, name) => {
  const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : null;
};
const isAdmin = req => {
  const t = getCookie(req, 'eps_session');
  const exp = t && sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');
const send = (res, code, body, type = 'application/json', extra = {}) => {
  res.writeHead(code, {
    'Content-Type': type, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': CSP,
    ...extra,
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readRaw = (req, max = 300_000) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

// ---- data validation ----
const readBody = async req => (await readRaw(req, 1_000_000)).toString();
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const num = (v, max = 9999) => { const x = Math.floor(Number(v)); return Number.isFinite(x) && x >= 0 ? Math.min(x, max) : 0; };
const score = v => (v === null || v === '' || v === undefined) ? null : num(v, 99);
const okImage = u => LOGO_RE.test(u) && fs.existsSync(uploadFile(u));
function sanitize(d) {
  if (!d || typeof d !== 'object') throw new Error('bad data');
  const teams = (Array.isArray(d.teams) ? d.teams : []).slice(0, 64).map(t => ({
    id: str(t.id, 40) || crypto.randomUUID(),
    name: str(t.name, 40) || 'Unnamed team',
    color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#1b57c4',
    logo: okImage(t.logo) ? t.logo : '',
    gm: str(t.gm, 40),
    am: str(t.am, 40),
  }));
  const ids = new Set(teams.map(t => t.id));
  const rounds = (Array.isArray(d.rounds) ? d.rounds : []).slice(0, 100).map(r => ({
    id: str(r.id, 40) || crypto.randomUUID(),
    name: str(r.name, 40) || 'Round',
  }));
  const roundIds = new Set(rounds.map(r => r.id));
  const matches =(Array.isArray(d.matches) ? d.matches : []).slice(0, 2000).filter(m => ids.has(m.a) && ids.has(m.b) && m.a !== m.b).map(m => ({
    id: str(m.id, 40) || crypto.randomUUID(),
    date: str(m.date, 25), a: m.a, b: m.b,
    round: roundIds.has(m.round) ? m.round : '',
    // up to 3 games, each with its own score; the old single-score format becomes game 1
    games: (Array.isArray(m.games) ? m.games : (m.as != null && m.bs != null ? [{ as: m.as, bs: m.bs }] : []))
      .slice(0, 3).map(g => ({ as: score(g && g.as), bs: score(g && g.bs) })),
  }));
  const players = (Array.isArray(d.players) ? d.players : []).slice(0, 1000).filter(p => ids.has(p.team)).map(p => ({
    id: str(p.id, 40) || crypto.randomUUID(),
    name: str(p.name, 40) || 'Player', team: p.team,
    role: p.role === 'goalie' ? 'goalie' : 'skater',
    number: str(p.number, 3).replace(/[^0-9]/g, ''),
    tag: p.tag === 'GM' || p.tag === 'AM' ? p.tag : '',
    g: num(p.g), a: num(p.a), saves: num(p.saves), shots: num(p.shots),
  }));
  const staff = (Array.isArray(d.staff) ? d.staff : []).slice(0, 200).map(s => ({
    id: str(s.id, 40) || crypto.randomUUID(),
    name: str(s.name, 40) || 'Unnamed',
    role: str(s.role, 30) || 'Moderator',
    bio: str(s.bio, 240),
    photo: okImage(s.photo) ? s.photo : '',
  }));
  const gallery = (Array.isArray(d.gallery) ? d.gallery : []).slice(0, 500)
    .filter(g => okImage(g.photo))
    .map(g => ({ id: str(g.id, 40) || crypto.randomUUID(), photo: g.photo, caption: str(g.caption, 140) }));
  return { teams, rounds, matches, players, staff, gallery };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  try {
    if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (p === '/api/data' && req.method === 'GET') return send(res, 200, fs.readFileSync(DATA_FILE));
    if (p === '/api/me') return send(res, 200, { admin: isAdmin(req) });

    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      const f = fails.get(ip) || { n: 0, until: 0 };
      if (f.until > Date.now()) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      const { password } = JSON.parse(await readBody(req) || '{}');
      if (!(await checkPassword(password ?? ''))) {
        f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60000; f.n = 0; }
        fails.set(ip, f);
        return send(res, 401, { error: 'Wrong password' });
      }
      fails.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_MS);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': `eps_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const t = getCookie(req, 'eps_session'); if (t) sessions.delete(t);
      return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': 'eps_session=; Max-Age=0; Path=/' });
    }
    if (p === '/api/data' && req.method === 'PUT') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Not logged in' });
      const clean = sanitize(JSON.parse(await readBody(req)));
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(clean, null, 2));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
      // remove uploaded images no team, staff member or gallery entry uses any more
      const used = new Set([...clean.teams.map(t => t.logo), ...clean.staff.map(s => s.photo), ...clean.gallery.map(g => g.photo)].map(u => path.basename(u || '')));
      for (const f of fs.readdirSync(UPLOAD_DIR)) if (!used.has(f)) fs.unlink(path.join(UPLOAD_DIR, f), () => {});
      return send(res, 200, clean);
    }
    if (p === '/api/upload' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Not logged in' });
      let buf;
      try { buf = await readRaw(req, 8_000_000); } catch { return send(res, 413, { error: 'Image too large (max 8 MB)' }); }
      const ext = sniff(buf);
      if (!ext) return send(res, 400, { error: 'Use a PNG, JPG, WEBP or GIF image' });
      const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
      return send(res, 200, { url: '/uploads/' + name });
    }
    if (req.method === 'GET' && LOGO_RE.test(p)) {
      const f = uploadFile(p);
      if (!fs.existsSync(f)) return send(res, 404, { error: 'Not found' });
      return send(res, 200, fs.readFileSync(f), IMG_TYPES[p.split('.').pop()], { 'Cache-Control': 'public, max-age=31536000, immutable' });
    }
    const s = STATIC[p];
    if (s && req.method === 'GET') {
      const extra = { 'Cache-Control': 'no-cache' };
      if (p.startsWith('/admin')) extra['X-Robots-Tag'] = 'noindex';
      return send(res, 200, fs.readFileSync(path.join(DIR, s[0])), s[1], extra);
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 400, { error: 'Bad request' });
  }
});
server.listen(PORT, () => console.log(`EPS site running on http://localhost:${PORT}  (admin: /admin)  data: ${DATA_DIR}`));

// stop cleanly when the host restarts or redeploys the app
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
