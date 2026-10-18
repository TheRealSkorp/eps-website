// EPS website server - zero dependencies. Run: node server.js
//
// Environment variables (all optional locally, see README.md for hosting):
//   PORT                  port to listen on (default 3000)
//   DATA_DIR              folder for data.json and uploads/ (default: this folder). Point it at a persistent disk when hosting.
//   ADMIN_PASSWORD_HASH   hashed admin password, made with: node hash-password.js   (recommended when hosting)
//   ADMIN_PASSWORD        plain admin password (simpler, less safe than the hash)
//   NODE_ENV=production   refuses to start without a password set, instead of generating one
//   TRUST_PROXY=1         set when behind a hosting proxy so login lockouts work per visitor
//   BOT_TOKEN             secret the Discord bot uses to send match results (POST /api/bot/result). Unset = bot link off.
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
    fs.writeFileSync(DATA_FILE, JSON.stringify({ teams: [], rounds: [], matches: [], players: [], staff: [], gallery: [], news: [], inbox: [] }, null, 2));
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
  '/standings.js': ['standings.js', 'application/javascript; charset=utf-8'],
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
    photo: okImage(t.photo) ? t.photo : '',   // optional picture of the whole team
    code: str(t.code, 12),   // short code the Discord bot uses for this team, e.g. GV
    slug: str(t.slug, 40),   // address of the team page: /team/<slug> (cleaned and made unique just below)
    gm: str(t.gm, 40),
    am: str(t.am, 40),
  }));
  // Team page addresses: keep a saved slug, else the team id when it is already a clean slug (so existing teams keep
  // URLs without any migration), else the name. A slug never changes just because a team is renamed.
  const seenSlugs = new Set();
  for (const t of teams) {
    const idIsUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(t.id);   // ids of teams added in the admin are random, so use the name for those
    const base = slugify(t.slug) || (!idIsUuid && SLUG_RE.test(t.id) && t.id.length <= 40 ? t.id : '') || slugify(t.name) || 'team';
    let s = base, n = 2;
    while (seenSlugs.has(s)) { const suffix = '-' + n++; s = base.slice(0, 40 - suffix.length) + suffix; }
    seenSlugs.add(s); t.slug = s;
  }
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
  const news = (Array.isArray(d.news) ? d.news : []).slice(0, 300).map(n => ({
    id: str(n.id, 40) || crypto.randomUUID(),
    title: str(n.title, 120) || 'Untitled',
    body: String(n.body ?? '').trim().slice(0, 2000),
    date: /^\d{4}-\d{2}-\d{2}$/.test(n.date) ? n.date : new Date().toISOString().slice(0, 10),
    pinned: !!n.pinned,
    bar: !!n.bar,
  }));
  // playoff bracket: three existing rounds are its stages; empty seeds mean "follow the live standings"
  let bracket = null;
  if (d.bracket && typeof d.bracket === 'object') {
    const b = d.bracket;
    const pick = id => (typeof id === 'string' && roundIds.has(id)) ? id : '';
    let qf = pick(b.qf), sf = pick(b.sf), f = pick(b.f);
    if (sf && sf === qf) sf = '';
    if (f && (f === qf || f === sf)) f = '';
    let seeds = Array.isArray(b.seeds) ? [...new Set(b.seeds.filter(id => ids.has(id)))].slice(0, 8) : [];
    if (seeds.length !== 8) seeds = [];
    bracket = { published: b.published === true, qf, sf, f, seeds };
  }
  return { teams, rounds, matches, players, staff, gallery, news, bracket };
}

// ---- team pages: /team/<slug> ----
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const slugify = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// a team is found by its page address, or by its id (old links)
const findTeam = (data, seg) => (data.teams || []).find(t => (t.slug || t.id) === seg) || (data.teams || []).find(t => t.id === seg);

// ---- separate pages: /standings, /matches, ... The same index.html; the page picks its view from the address. ----
const PAGES = {
  news: ['News', 'News and announcements from the European Puck Series.'],
  matches: ['Matches', 'Fixtures and results of the European Puck Series, round by round.'],
  gallery: ['Gallery', 'Photos from the matches of the European Puck Series.'],
  standings: ['Standings', 'The European Puck Series table: points, series, games and goals of every team.'],
  playoffs: ['Playoffs', 'The European Puck Series playoff bracket: the top 8 teams in a knockout.'],
  teams: ['Teams', 'Every team in the European Puck Series, with rosters, GMs and AMs.'],
  leaders: ['Leaders', 'European Puck Series leaders: top goal scorers, assists and goalies.'],
  rules: ['Rules', 'The rules of the European Puck Series community.'],
  staff: ['Staff', 'The people who run the European Puck Series.'],
};

// index.html with the title, description and link preview of one page filled in
function pageHtml(req, { title, desc, route, image }) {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const host = String(req.headers.host || '');
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const origin = /^[a-z0-9.:-]+$/i.test(host) ? `${proto}://${host}` : '';
  const url = origin + route;
  image = origin ? origin + (image || '/logo.png') : '';
  const extra = [
    origin ? `<link rel="canonical" href="${escHtml(url)}">` : '',
    origin ? `<meta property="og:url" content="${escHtml(url)}">` : '',
    image ? `<meta property="og:image" content="${escHtml(image)}">` : '',
    '<meta property="og:site_name" content="European Puck Series">',
    '<meta name="twitter:card" content="summary">',
  ].join('');
  return html
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escHtml(title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${escHtml(desc)}">`)
    .replace(/<meta property="og:title"[^>]*>/, () => `<meta property="og:title" content="${escHtml(title)}">`)
    .replace(/<meta property="og:description"[^>]*>/, () => `<meta property="og:description" content="${escHtml(desc)}">`)
    .replace('</head>', () => extra + '</head>');
}

function teamPageHtml(req, team) {
  if (!team) {   // unknown team: same page, told to show a "not found" view and kept out of search engines
    return fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')
      .replace(/<title>[^<]*<\/title>/, '<title>Team not found | EPS</title>')
      .replace('</head>', '<meta name="robots" content="noindex"><script>window.__EPS_404=1</script></head>');
  }
  return pageHtml(req, {
    title: `${team.name} | EPS`,
    desc: `${team.name}${team.gm ? ` (GM ${team.gm})` : ''} in the European Puck Series: roster, fixtures and results.`,
    route: `/team/${team.slug || team.id}`,
    image: team.logo,
  });
}

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const writeData = d => {
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(d, null, 2));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
};

// A result sent by the Discord bot. Anything unexpected is rejected, nothing is guessed.
// Blue = away = team A of a match, red = home = team B (same order the bot uses).
function cleanBotResult(r) {
  if (!r || typeof r !== 'object') return null;
  const id = String(r.match_id ?? '').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return null;
  const blueCode = str(r.blue_code, 12), redCode = str(r.red_code, 12);
  if (!blueCode || !redCode || blueCode.toLowerCase() === redCode.toLowerCase()) return null;
  const rawGames = Array.isArray(r.games) ? r.games.slice(0, 3) : [];
  if (rawGames.length < 2) return null;
  const games = [];
  for (const g of rawGames) {
    const a = Number(g && g.blue), b = Number(g && g.red);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 99 || b > 99) return null;
    games.push({ as: a, bs: b });
  }
  const round = Number.isInteger(r.round) && r.round >= 1 && r.round <= 9999 ? r.round : null;
  const t = Number(r.played_at);
  const played = Number.isFinite(t) && t > 0 ? new Date(t > 1e11 ? t : t * 1000) : new Date();
  return {
    id, blueCode, redCode,
    blueName: str(r.blue_name, 40), redName: str(r.red_name, 40),
    round, games,
    playedAt: isNaN(played) ? new Date().toISOString() : played.toISOString(),
    receivedAt: new Date().toISOString(),
    url: /^https:\/\/(discord\.com|discordapp\.com)\//.test(String(r.message_url || '')) ? String(r.message_url).slice(0, 300) : '',
  };
}

// What a visitor may see. Until the bracket is published, admins get everything, while everyone else gets no
// `bracket` field and none of the matches or rounds that belong to it (they would leak the draft otherwise).
function publicView(data, admin) {
  if (admin) return data;
  data = { ...data }; delete data.inbox;   // results waiting for approval are admin-only
  const b = data.bracket;
  if (b && b.published === true) return data;
  const out = { ...data };
  delete out.bracket;
  const hidden = new Set(b ? [b.qf, b.sf, b.f].filter(Boolean) : []);
  if (hidden.size) {
    out.matches = (data.matches || []).filter(m => !hidden.has(m.round));
    out.rounds = (data.rounds || []).filter(r => !hidden.has(r.id));
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  try {
    if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (p === '/api/data' && req.method === 'GET') {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return send(res, 200, publicView(data, isAdmin(req)));
    }
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
      // Results from the bot are owned by the server, not by whatever the admin page had loaded: keep the inbox
      // exactly as it is on disk right now, minus the ones that were just approved (they are matches now).
      // (Read and write happen with no await in between, so a bot result arriving at the same time is not lost.)
      let current = {};
      try { current = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
      const approved = new Set(clean.matches.map(m => m.id));
      clean.inbox = (Array.isArray(current.inbox) ? current.inbox : []).filter(x => !approved.has(x.id));
      writeData(clean);
      // remove uploaded images no team, staff member or gallery entry uses any more
      const used = new Set([...clean.teams.flatMap(t => [t.logo, t.photo]), ...clean.staff.map(s => s.photo), ...clean.gallery.map(g => g.photo)].map(u => path.basename(u || '')));
      for (const f of fs.readdirSync(UPLOAD_DIR)) if (!used.has(f)) fs.unlink(path.join(UPLOAD_DIR, f), () => {});
      return send(res, 200, clean);
    }
    // ---- Discord bot: sends a confirmed result, which waits in the inbox until an admin approves it ----
    if (p === '/api/bot/result' && req.method === 'POST') {
      if (!BOT_TOKEN) return send(res, 503, { error: 'The bot connection is not enabled on this site' });
      const key = 'bot:' + clientIp(req);
      const f = fails.get(key) || { n: 0, until: 0 };
      if (f.until > Date.now()) return send(res, 429, { error: 'Too many attempts. Try again later.' });
      const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!safeEq(given, BOT_TOKEN)) {
        f.n++; if (f.n >= 10) { f.until = Date.now() + 5 * 60000; f.n = 0; }
        fails.set(key, f);
        return send(res, 401, { error: 'Wrong token' });
      }
      fails.delete(key);
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      const item = cleanBotResult(body);
      if (!item) return send(res, 400, { error: 'Invalid result: need match_id, blue_code, red_code and 2 or 3 games with blue/red scores' });
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if ((data.matches || []).some(m => m.id === item.id)) return send(res, 200, { ok: true, status: 'already_approved' });
      data.inbox = (Array.isArray(data.inbox) ? data.inbox : []).filter(x => x.id !== item.id).concat(item).slice(-200);
      writeData(data);
      return send(res, 200, { ok: true, status: 'queued' });
    }
    if (p === '/api/inbox/reject' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Not logged in' });
      const { id } = JSON.parse(await readBody(req) || '{}');
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      data.inbox = (Array.isArray(data.inbox) ? data.inbox : []).filter(x => x.id !== id);
      writeData(data);
      return send(res, 200, { ok: true });
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
    // team pages: the same page for every team, with that team's title and link preview filled in
    const tm = p.match(/^\/team\/([^/]+)\/?$/);
    if (tm && (req.method === 'GET' || req.method === 'HEAD')) {
      let seg = ''; try { seg = decodeURIComponent(tm[1]).toLowerCase(); } catch {}
      const data = publicView(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')), false);
      const team = /^[a-z0-9-]{1,40}$/.test(seg) ? findTeam(data, seg) : null;
      const html = { 'Cache-Control': 'no-cache', 'Content-Type': 'text/html; charset=utf-8' };
      if (!team) return send(res, 404, teamPageHtml(req, null), html['Content-Type'], { 'Cache-Control': 'no-cache' });
      const canonical = team.slug || team.id;
      if (seg !== canonical) { res.writeHead(301, { Location: '/team/' + canonical, 'Cache-Control': 'no-cache' }); return res.end(); }
      return send(res, 200, teamPageHtml(req, team), html['Content-Type'], { 'Cache-Control': 'no-cache' });
    }
    // section pages: /standings, /matches, ... (a trailing slash is allowed)
    const pm = p.match(/^\/([a-z]+)\/?$/);
    if (pm && Object.hasOwn(PAGES, pm[1]) && (req.method === 'GET' || req.method === 'HEAD')) {
      const [name, desc] = PAGES[pm[1]];
      return send(res, 200, pageHtml(req, { title: `${name} | EPS`, desc, route: '/' + pm[1] }), 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache' });
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
