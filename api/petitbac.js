// API du Petit Bac (fonction serverless Vercel).
// Toute la partie est stockée dans Redis (Upstash, via l'intégration Vercel) :
// le serveur fait autorité, aucun joueur n'a besoin de garder sa page ouverte.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 6 * 3600;               // une partie est effacée après 6 h d'inactivité
const ONLINE_MS = 15000;            // sans nouvelles depuis 15 s = déconnecté
const HOST_TAKEOVER_MS = 30000;     // l'hôte absent depuis 30 s est remplacé
const ROLL_MS = 2600, COLLECT_MS = 2500, MAX_PLAYERS = 20;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LETTERS_ALL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LETTERS_EASY = 'ABCDEFGHIJLMNOPRSTUV';
const CLASSIC = ['Prénom', 'Pays', 'Ville', 'Animal', 'Fruit ou légume', 'Métier', 'Objet', 'Célébrité'];

/* ---------- Stockage ---------- */
// Compare-and-set : n'écrit l'état que si la version n'a pas bougé entre-temps.
const CAS_LUA = "if (redis.call('GET', KEYS[2]) or '0') ~= ARGV[1] then return 0 end " +
  "redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4]) redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4]) return 1";

const mem = globalThis.__pbMem || (globalThis.__pbMem = new Map()); // repli local (tests sans Redis)
function memRun([cmd, ...a]){
  switch (cmd){
    case 'GET': return mem.has(a[0]) ? mem.get(a[0]) : null;
    case 'SET': if (a.includes('NX') && mem.has(a[0])) return null; mem.set(a[0], a[1]); return 'OK';
    case 'HSET': { const h = mem.get(a[0]) || {}; for (let i = 1; i < a.length; i += 2) h[a[i]] = a[i + 1]; mem.set(a[0], h); return 1; }
    case 'HGETALL': { const h = mem.get(a[0]) || {}; return Object.entries(h).flat(); }
    case 'EXPIRE': return 1;
    case 'EVAL': {
      const [, , k1, k2, expect, val, ver] = a;
      if ((mem.get(k2) || '0') !== expect) return 0;
      mem.set(k1, val); mem.set(k2, ver); return 1;
    }
  }
  throw new Error('cmd ' + cmd);
}
async function redis(cmds){
  if (!REDIS_URL) return cmds.map(memRun);
  const r = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('Redis HTTP ' + r.status);
  const j = await r.json();
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const K = code => ({ s: 'pb:' + code, v: 'pb:' + code + ':v', seen: 'pb:' + code + ':seen', ans: r => 'pb:' + code + ':ans:' + r });
const hashToObj = arr => { const o = {}; for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o; };

async function load(code){
  const [s] = await redis([['GET', K(code).s]]);
  return s ? JSON.parse(s) : null;
}
// Applique fn(state) puis enregistre, en réessayant si quelqu'un a écrit en même temps.
async function update(code, fn){
  const k = K(code);
  for (let i = 0; i < 10; i++){
    const [raw, ver] = await redis([['GET', k.s], ['GET', k.v]]);
    if (!raw) throw httpErr(404, 'Aucune partie trouvée avec ce code');
    const s = JSON.parse(raw);
    const changed = await fn(s);
    if (changed === false) return s;
    const cur = String(ver || '0');
    s.v = (+cur || 0) + 1;
    const [ok] = await redis([['EVAL', CAS_LUA, 2, k.s, k.v, cur, JSON.stringify(s), String(s.v), String(TTL)]]);
    if (ok === 1) return s;
    await new Promise(r => setTimeout(r, 20 + Math.random() * 80));
  }
  throw httpErr(503, 'Serveur occupé, réessaie');
}
function httpErr(status, msg){ const e = new Error(msg); e.status = status; return e; }

/* ---------- Règles du jeu ---------- */
function norm(s){
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9' -]/g, '').replace(/\s+/g, ' ').trim();
}
function canon(s){ // pour détecter les doublons : sans article, sans pluriel
  let n = norm(s).replace(/^(le|la|les|un|une|des|du|l')\s*/, '').replace(/[' -]/g, '');
  if (n.length > 3) n = n.replace(/(s|x)$/, '');
  return n;
}
function startsOk(word, letter){
  const n = norm(word).replace(/^[' -]+/, '');
  if (!n) return false;
  const L = letter.toLowerCase();
  if (n[0] === L) return true;
  return n.replace(/^(le|la|les|un|une|des|du|l')\s*/, '')[0] === L;
}
function computeResult(s){
  const uids = Object.keys(s.answers || {});
  const voters = uids.length - 1;
  const res = {};
  uids.forEach(u => res[u] = { cats: {}, total: 0 });
  s.settings.categories.forEach(cat => {
    const valid = [];
    uids.forEach(u => {
      const w = String(s.answers[u][cat] || '').trim();
      const v = (s.votes[u + '|' + cat] || []).length;
      let status;
      if (!w) status = 'empty';
      else if (!startsOk(w, s.letter)) status = 'bad';
      else if (voters > 0 && v * 2 > voters) status = 'bad';
      else { status = 'ok'; valid.push({ u, c: canon(w) }); }
      res[u].cats[cat] = { status, pts: 0 };
    });
    valid.forEach(({ u, c }) => {
      const r = res[u].cats[cat];
      if (valid.filter(o => o.c === c).length > 1){ r.status = 'dup'; r.pts = 5; } else r.pts = 10;
      res[u].total += r.pts;
    });
  });
  s.result = res;
}
function cleanName(s, uid, name){
  let clean = String(name || 'Joueur').trim().slice(0, 16) || 'Joueur';
  const base = clean; let i = 2;
  while (s.players.some(o => o.uid !== uid && o.name.toLowerCase() === clean.toLowerCase())) clean = base + ' ' + (i++);
  return clean;
}
function startRound(s, now){
  if (!s.settings.categories.length) throw httpErr(400, 'Ajoute au moins une catégorie');
  const pool = (s.settings.letters === 'all' ? LETTERS_ALL : LETTERS_EASY).split('');
  let avail = pool.filter(l => !s.usedLetters.includes(l));
  if (!avail.length){ s.usedLetters = []; avail = pool; }
  const letter = avail[Math.floor(Math.random() * avail.length)];
  s.usedLetters.push(letter);
  s.round++; s.letter = letter; s.phase = 'rolling'; s.rollUntil = now + ROLL_MS;
  s.stoppedBy = null; s.answers = null; s.votes = {}; s.result = null; s.endsAt = 0;
}
// Fait avancer les phases liées au temps (tirage -> jeu -> ramassage -> correction).
async function advance(code, s, now){
  const due = (s.phase === 'rolling' && now >= s.rollUntil) ||
    (s.phase === 'playing' && s.endsAt && now >= s.endsAt) ||
    (s.phase === 'collecting' && now >= s.collectUntil);
  if (!due) return s;
  return update(code, async st => {
    let changed = false;
    if (st.phase === 'rolling' && now >= st.rollUntil){
      st.phase = 'playing'; st.endsAt = st.settings.duration ? st.rollUntil + st.settings.duration * 1000 : 0; changed = true;
    }
    if (st.phase === 'playing' && st.endsAt && now >= st.endsAt){ st.phase = 'collecting'; st.collectUntil = st.endsAt + COLLECT_MS; changed = true; }
    if (st.phase === 'collecting' && now >= st.collectUntil){
      const [raw] = await redis([['HGETALL', K(code).ans(st.round)]]);
      const ans = hashToObj(raw);
      st.answers = {};
      st.players.forEach(p => { st.answers[p.uid] = ans[p.uid] ? JSON.parse(ans[p.uid]) : {}; });
      st.votes = {}; st.phase = 'review'; computeResult(st); changed = true;
    }
    return changed;
  });
}
function sanitizeSettings(x, old){
  const s = Object.assign({}, old);
  if (x && Array.isArray(x.categories)){
    const seen = new Set();
    s.categories = x.categories.map(c => String(c).trim().slice(0, 30)).filter(c => c && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase())).slice(0, 20);
  }
  if (x && [0, 60, 90, 120, 180, 240, 300].includes(+x.duration)) s.duration = +x.duration;
  if (x && [0, 3, 5, 8, 10].includes(+x.rounds)) s.rounds = +x.rounds;
  if (x && [0, 5, 10, 15, 20].includes(+x.stopDelay)) s.stopDelay = +x.stopDelay;
  if (x && ['easy', 'all'].includes(x.letters)) s.letters = x.letters;
  return s;
}

/* ---------- Actions ---------- */
async function act(b){
  const now = Date.now();
  const uid = typeof b.uid === 'string' ? b.uid.slice(0, 40) : '';
  if (!uid) throw httpErr(400, 'uid manquant');
  const code = String(b.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  const k = K(code);
  const beat = () => redis([['HSET', k.seen, uid, String(now)], ['EXPIRE', k.seen, TTL]]);
  const requireHost = s => { if (s.hostUid !== uid) throw httpErr(403, "Seul l'hôte peut faire ça"); };

  if (b.action === 'create'){
    for (let i = 0; i < 20; i++){
      let c = ''; for (let j = 0; j < 4; j++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      const kk = K(c);
      const s = {
        code: c, v: 1, phase: 'lobby', round: 0, letter: '', usedLetters: [], endsAt: 0, stoppedBy: null,
        hostUid: uid, players: [{ uid, name: String(b.name || 'Joueur').trim().slice(0, 16) || 'Joueur', score: 0 }], banned: [],
        settings: { categories: CLASSIC.slice(), duration: 120, rounds: 5, stopDelay: 10, letters: 'easy' },
        answers: null, votes: {}, result: null
      };
      const [ok] = await redis([['SET', kk.v, '1', 'NX', 'EX', String(TTL)]]);
      if (ok !== 'OK') continue;
      await redis([['SET', kk.s, JSON.stringify(s), 'EX', String(TTL)], ['HSET', kk.seen, uid, String(now)], ['EXPIRE', kk.seen, TTL]]);
      return { state: s, seen: { [uid]: String(now) } };
    }
    throw httpErr(503, 'Impossible de créer une partie, réessaie');
  }

  if (code.length !== 4) throw httpErr(400, 'Le code fait 4 lettres');

  if (b.action === 'answers'){ // écrit à part pour ne pas bloquer les autres joueurs
    const a = {};
    if (b.a && typeof b.a === 'object') Object.keys(b.a).slice(0, 20).forEach(c => { if (typeof b.a[c] === 'string') a[String(c).slice(0, 30)] = b.a[c].slice(0, 40); });
    const r = parseInt(b.round, 10) || 0;
    await redis([['HSET', k.ans(r), uid, JSON.stringify(a)], ['EXPIRE', k.ans(r), TTL]]);
    return { ok: true };
  }

  if (b.action === 'poll'){
    const cmds = [['GET', k.v]];
    if (b.beat) cmds.push(['HSET', k.seen, uid, String(now)], ['EXPIRE', k.seen, TTL], ['HGETALL', k.seen]);
    const out = await redis(cmds);
    if (!out[0]) throw httpErr(404, 'Cette partie est terminée ou a expiré');
    let seen = b.beat ? hashToObj(out[3]) : null;
    let s = null;
    if (String(out[0]) !== String(b.v)) s = await load(code);
    // phases liées au temps, et remplacement de l'hôte s'il a disparu
    const timeDue = b.phase && ['rolling', 'playing', 'collecting'].includes(b.phase);
    const hostGone = seen && b.host && b.host !== uid && now - (+seen[b.host] || 0) > HOST_TAKEOVER_MS;
    const st = s || (timeDue || hostGone ? await load(code) : null);
    if (st){
      const before = st.v;
      let s2 = await advance(code, st, now);
      if (seen && s2.hostUid !== uid && now - (+seen[s2.hostUid] || 0) > HOST_TAKEOVER_MS && s2.players.some(p => p.uid === uid)){
        s2 = await update(code, x => {
          if (now - (+seen[x.hostUid] || 0) <= HOST_TAKEOVER_MS) return false;
          const next = x.players.find(p => now - (+seen[p.uid] || 0) < ONLINE_MS);
          if (!next || next.uid === x.hostUid) return false;
          x.hostUid = next.uid; return true;
        });
      }
      if (s2.v !== +b.v || s2.v !== before) s = s2;
    }
    return { state: s, seen };
  }

  if (b.action === 'join'){
    const s = await update(code, s => {
      if (s.banned.includes(uid)) throw httpErr(403, 'Tu as été exclu de cette partie');
      const p = s.players.find(p => p.uid === uid);
      if (p){ if (b.name && p.name !== b.name){ p.name = cleanName(s, uid, b.name); return true; } return false; }
      if (s.players.length >= MAX_PLAYERS) throw httpErr(403, 'La partie est complète');
      s.players.push({ uid, name: cleanName(s, uid, b.name), score: 0 });
      if (!s.hostUid) s.hostUid = uid;
      return true;
    });
    await beat();
    const [raw] = await redis([['HGETALL', k.seen]]);
    return { state: s, seen: hashToObj(raw) };
  }

  let s;
  switch (b.action){
    case 'settings':
      s = await update(code, s => { requireHost(s); if (s.phase !== 'lobby') return false; s.settings = sanitizeSettings(b.settings, s.settings); });
      break;
    case 'start':
      s = await update(code, s => {
        requireHost(s);
        if (!['lobby', 'scores'].includes(s.phase)) return false;
        if (s.phase === 'scores' && s.settings.rounds && s.round >= s.settings.rounds){ s.phase = 'end'; return true; }
        startRound(s, now);
      });
      break;
    case 'stop':
      s = await update(code, s => {
        if (s.phase !== 'playing' || s.stoppedBy) return false;
        const p = s.players.find(p => p.uid === uid); if (!p) return false;
        s.stoppedBy = p.name;
        const end = now + s.settings.stopDelay * 1000;
        s.endsAt = s.endsAt ? Math.min(s.endsAt, end) : end;
      });
      s = await advance(code, s, now);
      break;
    case 'vote':
      s = await update(code, s => {
        const key = String(b.key || '');
        if (s.phase !== 'review' || key.startsWith(uid + '|') || !s.answers || !s.answers[key.split('|')[0]]) return false;
        if (!s.players.some(p => p.uid === uid)) return false;
        const arr = s.votes[key] || [];
        const i = arr.indexOf(uid);
        if (i >= 0) arr.splice(i, 1); else arr.push(uid);
        s.votes[key] = arr; computeResult(s);
      });
      break;
    case 'validate':
      s = await update(code, s => {
        requireHost(s); if (s.phase !== 'review') return false;
        computeResult(s);
        s.players.forEach(p => { if (s.result[p.uid]) p.score += s.result[p.uid].total; });
        s.phase = 'scores';
      });
      break;
    case 'finish':
      s = await update(code, s => { requireHost(s); if (s.phase === 'end') return false; s.phase = 'end'; });
      break;
    case 'replay':
      s = await update(code, s => {
        requireHost(s);
        s.players.forEach(p => p.score = 0);
        s.round = 0; s.usedLetters = []; s.phase = 'lobby'; s.answers = null; s.result = null; s.votes = {};
      });
      break;
    case 'kick':
      s = await update(code, s => {
        requireHost(s);
        if (!b.target || b.target === uid) return false;
        s.banned.push(String(b.target));
        s.players = s.players.filter(p => p.uid !== b.target);
      });
      break;
    case 'leave':
      s = await update(code, s => {
        if (!s.players.some(p => p.uid === uid)) return false;
        s.players = s.players.filter(p => p.uid !== uid);
        if (s.hostUid === uid) s.hostUid = s.players.length ? s.players[0].uid : null;
      });
      return { ok: true };
    default:
      throw httpErr(400, 'Action inconnue');
  }
  return { state: s };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS'){ res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST'){ res.statusCode = 405; return res.end(); }
  try{
    let b = req.body;
    if (typeof b === 'string') b = JSON.parse(b || '{}');
    if (!b){
      let raw = ''; for await (const ch of req) raw += ch;
      b = JSON.parse(raw || '{}');
    }
    const out = await act(b || {});
    out.now = Date.now();
    out.storage = REDIS_URL ? 'redis' : 'memory';
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(out));
  }catch(e){
    res.statusCode = e.status || 500; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: e.status ? e.message : 'Erreur serveur : ' + e.message, now: Date.now() }));
  }
};
