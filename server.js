// Servidor de Poliana: salas con código, reglas y turnos del lado del servidor.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const END = 57;                                   // paso final: casa 7
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
const ringIdx = (ci, st) => (ci * 14 + 6 + st) % 56;
const cur = r => r.seats[r.cur];
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

// ---- reglas ----
function enterOpt(r) {
  if (r.used[0] || r.used[1]) return null;
  const k = cur(r).steps.indexOf(-1); if (k < 0) return null;
  const [a, b] = r.dice;
  if (a + b === 6) return { i: k, target: 0 };                         // suma 6: casilla 1
  if ((a === 6 && b === 3) || (a === 3 && b === 6)) return { i: k, target: 2 }; // 6 y 3: casilla 3 de color
  return null;
}
function amounts(r) {
  const l = [];
  if (!r.used[0]) l.push({ key: '0', use: [0], val: r.dice[0] });
  if (!r.used[1]) l.push({ key: '1', use: [1], val: r.dice[1] });
  if (!r.used[0] && !r.used[1]) l.push({ key: 's', use: [0, 1], val: r.dice[0] + r.dice[1], sum: true });
  return l;
}
const moveOpts = (p, a) => p.steps.map((s, i) => (s >= 0 && s < END && s + a.val <= END) ? i : -1).filter(i => i >= 0);
const anyLegal = r => !!enterOpt(r) || amounts(r).some(a => moveOpts(cur(r), a).length);

function hit(r, p, t) {                          // caer sobre un rival lo manda a su celda
  if (t < 0 || t > 50) return 0;
  const idx = ringIdx(p.ci, t); let n = 0;
  r.seats.forEach(q => { if (q !== p) q.steps.forEach((s, j) => { if (s >= 0 && s <= 50 && ringIdx(q.ci, s) === idx) { q.steps[j] = -1; n++; } }); });
  return n;
}

// ---- estado ----
function broadcast(r) {
  const e = r.phase === 'move' ? enterOpt(r) : null;
  const legal = r.phase === 'move'
    ? { enter: e ? e.i : -1, amts: amounts(r).map(a => ({ key: a.key, val: a.val, sum: !!a.sum, pieces: moveOpts(cur(r), a) })) }
    : null;
  r.seats.forEach((s, idx) => send(s.ws, {
    t: 'state', code: r.code, you: idx, id: s.id, phase: r.phase, cur: r.cur,
    dice: r.dice, used: r.used, msg: r.msg, legal,
    players: r.seats.map(q => ({ name: q.name, ci: q.ci, steps: q.steps, on: q.on }))
  }));
}
function advance(r) {
  clearTimeout(r.timer);
  for (let k = 0; k < r.seats.length; k++) { r.cur = (r.cur + 1) % r.seats.length; if (cur(r).on) break; }
  r.phase = 'roll'; r.dice = [0, 0]; r.used = [false, false]; r.msg = 'Turno de ' + cur(r).name;
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
        room = { code: c, seats: [], phase: 'lobby', cur: 0, dice: [0, 0], used: [false, false], msg: '', timer: null, gc: null };
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
        seat = { id: crypto.randomBytes(8).toString('hex'), name: String(m.name || 'Jugador').slice(0, 14), ci: room.seats.length, steps: [-1, -1, -1, -1], ws, on: true };
        room.seats.push(seat);
      }
      ws.room = room; ws.seat = seat;
      return broadcast(room);
    }
    if (!r) return;

    if (m.t === 'start' && r.seats[0] === ws.seat && (r.phase === 'lobby' || r.phase === 'over')) {
      r.seats = r.seats.filter(s => s.on);
      const n = r.seats.length; if (n < 2) return fail('Se necesitan al menos 2 jugadores');
      r.seats.forEach((s, k) => { s.ci = ORDER[n][k]; s.steps = [-1, -1, -1, -1]; });
      r.cur = 0; r.phase = 'roll'; r.dice = [0, 0]; r.used = [false, false]; r.msg = 'Empieza ' + cur(r).name;
      return broadcast(r);
    }

    if (m.t === 'roll' && r.phase === 'roll' && cur(r) === ws.seat) {
      r.dice = [d6(), d6()]; r.used = [false, false];
      r.msg = `${ws.seat.name} sacó ${r.dice[0]} y ${r.dice[1]}`;
      if (anyLegal(r)) r.phase = 'move';
      else { r.phase = 'wait'; r.msg += ' · sin movimientos'; r.timer = setTimeout(() => advance(r), 1600); }
      return broadcast(r);
    }

    if (m.t === 'move' && r.phase === 'move' && cur(r) === ws.seat) {
      const p = ws.seat, i = m.i | 0; if (i < 0 || i > 3) return;
      let txt, n;
      if (m.key === 'e') {
        const o = enterOpt(r); if (!o || p.steps[i] !== -1) return;
        p.steps[i] = o.target; r.used = [true, true]; n = hit(r, p, o.target); txt = 'saca una ficha';
      } else {
        const a = amounts(r).find(x => x.key === m.key);
        if (!a || !moveOpts(p, a).includes(i)) return;
        const t = p.steps[i] + a.val; p.steps[i] = t; a.use.forEach(u => r.used[u] = true);
        n = hit(r, p, t); txt = t === END ? 'libera una ficha' : 'mueve ' + a.val;
      }
      r.msg = `${p.name} ${txt}` + (n ? ` y manda ${n} ${n > 1 ? 'fichas' : 'ficha'} a la celda` : '');
      if (p.steps.every(s => s === END)) { r.phase = 'over'; r.msg = `${p.name} liberó sus 4 fichas y ganó`; }
      else if (!anyLegal(r)) { r.phase = 'wait'; r.timer = setTimeout(() => advance(r), 1000); }
      return broadcast(r);
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
