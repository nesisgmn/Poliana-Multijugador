// Servidor de Poliana: salas con código, reglamento oficial y turnos del lado del servidor.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const END = 57;                                   // paso final: casa 7
const BONUS = 10;                                 // puntos extra por matar
const ORDER = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };
const PUB = path.join(__dirname, 'public');
const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.join(PUB, url === '/' ? 'index.html' : url);
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });
const rooms = new Map();

const code4 = () => Array.from({ length: 4 }, () => AL[Math.floor(Math.random() * AL.length)]).join('');
const d6 = () => 1 + Math.floor(Math.random() * 6);
const cur = r => r.seats[r.cur];
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const freshBlow = () => ({ n: 0, moves: [] });

// ---- geometría ----
// Casilla del carril (0..55) que ocupa el paso `st` del jugador de color `ci`.
const cell = (ci, st) => (ci * 14 + 6 + st) % 56;
// Casillas 1 a 8 de cada lado = "casa" (zona de salida) del dueño de ese lado.
const inZone = idx => idx % 14 >= 6;
const zoneSide = idx => Math.floor(idx / 14);

// ---- reglas ----
// Regla 1: se siembra solo con 3-3, 6-3, 4-2, 5-1 o 6-6.
function sowOpt(r) {
  if (r.bonus || r.used[0] || r.used[1]) return null;
  const p = cur(r), k = p.steps.indexOf(-1); if (k < 0) return null;
  const [a, b] = r.dice, lo = Math.min(a, b), hi = Math.max(a, b);
  let target = -1;
  if (a + b === 6) target = 0;                       // 3-3, 4-2, 5-1: casilla 1
  else if (lo === 3 && hi === 6) target = 2;         // 6-3: casilla 3 de color
  else if (a === 6 && b === 6) target = 0;           // 6-6: casilla 1
  if (target < 0) return null;
  if (p.steps.filter(x => x === target).length >= 3) return null;   // regla 6: torre de hasta 3 al sembrar
  return { i: k, target };
}

function amounts(r) {
  if (r.bonus) return [{ key: 'b', use: [], val: r.bonus, bonus: true }];   // regla 3: primero el bono
  const l = [];
  if (!r.used[0]) l.push({ key: '0', use: [0], val: r.dice[0] });
  if (!r.used[1]) l.push({ key: '1', use: [1], val: r.dice[1] });
  if (!r.used[0] && !r.used[1]) l.push({ key: 's', use: [0, 1], val: r.dice[0] + r.dice[1], sum: true });
  return l;
}

// Puede la ficha i del jugador p avanzar `val` casillas (torres, zona enemiga, meta)
function canStep(p, i, val) {
  const s = p.steps[i]; if (s < 0 || s >= END) return false;
  const t = s + val; if (t > END) return false;
  // regla 6: al avanzar con dados, torre de máximo 2 propias (la meta no cuenta)
  if (t < END && p.steps.filter((x, j) => j !== i && x === t).length >= 2) return false;
  // regla 5: en la casa del enemigo no hay torres ni se pasa por encima de fichas propias
  for (let u = s + 1; u <= t && u <= 50; u++) {
    const idx = cell(p.ci, u);
    if (inZone(idx) && zoneSide(idx) !== p.ci && p.steps.some((x, j) => j !== i && x === u)) return false;
  }
  return true;
}

// Rivales que mataría el jugador p al caer en el paso t.
function victims(r, p, t) {
  if (t < 0 || t > 50) return [];                    // la recta final es privada
  const idx = cell(p.ci, t);
  if (inZone(idx)) return [];                        // regla 5: en las casas nadie mata ni muere
  const out = [];
  r.seats.forEach(q => {
    if (q === p) return;
    q.steps.forEach((s, j) => { if (s >= 0 && s < 50 && cell(q.ci, s) === idx) out.push([q, j]); });   // regla 8: desde el 9 propio están a salvo
  });
  return out;
}

// Jugadas posibles. Prioridad: matar > sembrar > avanzar.
function options(r) {
  const p = cur(r), sow = sowOpt(r);
  const amts = amounts(r).map(a => {
    const pieces = [], kills = [];
    p.steps.forEach((s, i) => {
      if (!canStep(p, i, a.val)) return;
      pieces.push(i);
      if (victims(r, p, s + a.val).length) kills.push(i);
    });
    return { ...a, pieces, kills };
  });
  const anyKill = amts.some(a => a.kills.length > 0);
  if (sow && !anyKill) amts.forEach(a => { a.pieces = []; });        // si puede sembrar, no puede avanzar
  return { sow, amts, anyKill };
}
const anyLegal = r => { const o = options(r); return !!o.sow || o.amts.some(a => a.pieces.length); };

// ---- estado ----
function broadcast(r) {
  let legal = null;
  if (r.phase === 'move') {
    const o = options(r);
    legal = {
      enter: o.sow ? o.sow.i : -1, kill: o.anyKill, bonus: r.bonus,
      amts: o.amts.map(a => ({ key: a.key, val: a.val, sum: !!a.sum, bonus: !!a.bonus, pieces: a.pieces, kills: a.kills }))
    };
  }
  r.seats.forEach((s, idx) => send(s.ws, {
    t: 'state', code: r.code, you: idx, id: s.id, phase: r.phase, cur: r.cur,
    dice: r.dice, used: r.used, msg: r.msg, notice: r.notice, legal,
    players: r.seats.map(q => ({ name: q.name, ci: q.ci, steps: q.steps, on: q.on, skip: q.skip }))
  }));
}
function notify(r, text) { r.notice = { n: r.notice.n + 1, text }; }

// Pasa al siguiente jugador conectado; salta a quien tenga castigo pendiente (regla 9).
function advance(r) {
  clearTimeout(r.timer);
  const n = r.seats.length, lost = [];
  for (let g = 0; g < n * 2; g++) {
    r.cur = (r.cur + 1) % n;
    const s = cur(r);
    if (!s.on) continue;
    if (s.skip) { s.skip = false; lost.push(s.name); continue; }
    break;
  }
  r.phase = 'roll'; r.dice = [0, 0]; r.used = [false, false]; r.bonus = 0; r.blow = freshBlow();
  if (lost.length) notify(r, lost.join(', ') + ' pierde su turno por tirar fuera de turno');
  r.msg = (lost.length ? lost.join(', ') + ' pierde su turno · ' : '') + 'Turno de ' + cur(r).name;
  broadcast(r);
}

// Termina la tirada: con pares (regla 7) el mismo jugador vuelve a tirar.
function finishRoll(r) {
  clearTimeout(r.timer);
  if (r.phase !== 'over' && r.dice[0] && r.dice[0] === r.dice[1]) {
    r.phase = 'roll'; r.used = [true, true]; r.bonus = 0; r.blow = freshBlow();
    r.msg = `${cur(r).name} sacó pares y vuelve a tirar`;
    return broadcast(r);
  }
  advance(r);
}

function afterMove(r) {
  const p = cur(r);
  if (p.steps.every(s => s === END)) { r.phase = 'over'; r.bonus = 0; r.msg = `${p.name} liberó sus 4 fichas y ganó`; return broadcast(r); }
  // regla 3: si no hay forma de avanzar los 10, se pierde el bono y el dado que sobraba
  if (r.bonus && !p.steps.some((s, i) => canStep(p, i, r.bonus))) {
    r.bonus = 0; r.used = [true, true];
    r.msg += ` · no puede avanzar los ${BONUS} y pierde el resto de la tirada`;
  }
  if (anyLegal(r)) { r.phase = 'move'; return broadcast(r); }
  r.phase = 'wait'; clearTimeout(r.timer);
  r.timer = setTimeout(() => finishRoll(r), 1200);
  broadcast(r);
}

wss.on('connection', ws => {
  const fail = text => send(ws, { t: 'error', text });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const r = ws.room;

    if (m.t === 'create' || m.t === 'join') {
      let room;
      if (m.t === 'create') {
        let c; do { c = code4(); } while (rooms.has(c));
        room = { code: c, seats: [], phase: 'lobby', cur: 0, dice: [0, 0], used: [false, false], bonus: 0, blow: freshBlow(), notice: { n: 0, text: '' }, msg: '', timer: null, gc: null };
        rooms.set(c, room);
      } else {
        room = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!room) return fail('No existe esa sala');
      }
      clearTimeout(room.gc);
      let seat = m.id && room.seats.find(s => s.id === m.id);
      if (seat) { seat.ws = ws; seat.on = true; }                    // reconexión
      else {
        if (room.phase !== 'lobby') return fail('La partida ya empezó');
        if (room.seats.length >= 4) return fail('La sala está llena');
        seat = { id: crypto.randomBytes(8).toString('hex'), name: String(m.name || 'Jugador').slice(0, 14), ci: room.seats.length, steps: [-1, -1, -1, -1], skip: false, ws, on: true };
        room.seats.push(seat);
      }
      ws.room = room; ws.seat = seat;
      return broadcast(room);
    }
    if (!r) return;

    // Iniciar (anfitrión) o jugar otra partida (cualquiera, al terminar)
    if (m.t === 'start' && ((r.phase === 'lobby' && r.seats[0] === ws.seat) || r.phase === 'over')) {
      clearTimeout(r.timer);
      r.seats = r.seats.filter(s => s.on);
      const n = r.seats.length; if (n < 2) return fail('Se necesitan al menos 2 jugadores');
      r.seats.forEach((s, k) => { s.ci = ORDER[n][k]; s.steps = [-1, -1, -1, -1]; s.skip = false; });
      r.cur = 0; r.phase = 'roll'; r.dice = [0, 0]; r.used = [false, false]; r.bonus = 0; r.blow = freshBlow();
      r.msg = 'Empieza ' + cur(r).name;
      return broadcast(r);
    }

    if (m.t === 'roll') {
      if (r.phase === 'lobby' || r.phase === 'over') return;
      const me = ws.seat;
      if (cur(r) !== me) {                                           // regla 9: tirar fuera de turno
        if (!me.skip) {
          me.skip = true;
          notify(r, `${me.name} tiró fuera de su turno y pierde su siguiente turno`);
          broadcast(r);
        }
        return;
      }
      if (r.phase !== 'roll') return;
      r.dice = [d6(), d6()]; r.used = [false, false]; r.bonus = 0; r.blow = freshBlow();
      r.msg = `${me.name} sacó ${r.dice[0]} y ${r.dice[1]}`;
      if (anyLegal(r)) r.phase = 'move';
      else { r.phase = 'wait'; r.msg += ' · sin movimientos'; r.timer = setTimeout(() => finishRoll(r), 1600); }
      return broadcast(r);
    }

    if (m.t === 'move' && r.phase === 'move' && cur(r) === ws.seat) {
      const p = ws.seat, i = m.i | 0; if (i < 0 || i > 3) return;
      const o = options(r);
      let move, txt, n = 0, isKill = false;

      if (m.key === 'e') {                                           // sembrar
        if (!o.sow || p.steps[i] !== -1) return;
        move = { i, from: -1 };
        p.steps[i] = o.sow.target; r.used = [true, true]; txt = 'siembra una ficha';
      } else {                                                       // avanzar o usar el bono
        const a = o.amts.find(x => x.key === m.key);
        if (!a || !a.pieces.includes(i)) return;
        isKill = a.kills.includes(i);
        const from = p.steps[i], t = from + a.val, vs = victims(r, p, t);
        p.steps[i] = t;
        vs.forEach(([q, j]) => { q.steps[j] = -1; }); n = vs.length;
        a.use.forEach(u => { r.used[u] = true; });
        if (a.bonus) r.bonus = 0;
        if (n) r.bonus = BONUS;                                      // regla 2: matar da +10
        move = { i, from };
        txt = a.bonus ? `avanza el bono de ${BONUS}` : t === END ? 'libera una ficha' : 'mueve ' + a.val;
      }
      r.msg = `${p.name} ${txt}` + (n ? ` y manda ${n} ${n > 1 ? 'fichas' : 'ficha'} a la celda · +${BONUS} de bono` : '');

      // reglas 10 y 11: si podía matar y no lo hizo, "soplado"
      if (o.anyKill && !isKill) {
        const missed = Math.min(...o.amts.flatMap(a => a.kills));
        r.blow.moves.push(move); r.blow.n++;
        if (r.blow.n >= 2) {                                         // movió dos veces ignorando la captura
          for (let k = r.blow.moves.length - 1; k >= 0; k--) p.steps[r.blow.moves[k].i] = r.blow.moves[k].from;
          p.steps[missed] = -1;
          r.bonus = 0; r.used = [true, true]; r.blow = freshBlow(); r.phase = 'wait';
          r.msg = `¡Soplado! ${p.name} ignoró la captura: sus fichas regresan, la ficha ${missed + 1} vuelve a la celda y pierde el turno`;
          notify(r, r.msg);
          clearTimeout(r.timer); r.timer = setTimeout(() => advance(r), 2400);
          return broadcast(r);
        }
        p.steps[missed] = -1;
        r.msg += ` · ¡Soplado! Pudo matar y no lo hizo: su ficha ${missed + 1} vuelve a la celda`;
        notify(r, `¡Soplado! ${p.name} pudo matar y no lo hizo: su ficha ${missed + 1} vuelve a la celda`);
      }
      return afterMove(r);
    }
  });

  ws.on('close', () => {
    const r = ws.room, s = ws.seat;
    if (!r || !s || s.ws !== ws) return;
    s.on = false;
    if (r.phase === 'lobby') { r.seats = r.seats.filter(x => x !== s); r.seats.forEach((x, k) => x.ci = k); }
    if (!r.seats.some(x => x.on)) { clearTimeout(r.timer); r.gc = setTimeout(() => rooms.delete(r.code), 10 * 60 * 1000); return; }
    if (r.phase !== 'lobby' && r.phase !== 'over' && cur(r) === s) return advance(r);   // salta al que se desconectó
    broadcast(r);
  });
});

server.listen(PORT, () => console.log('Poliana lista en http://localhost:' + PORT));
