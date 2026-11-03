// Servidor de Poliana: salas con código, reglas completas y turnos del lado del servidor.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const END = 58;                  // meta: casa 7 de la escalera de llegada (pasos 52 a 58)
const RING = 51;                 // último paso sobre el carril exterior (casilla 9 de su propio lado)
const TURN_MS = 60000;           // 60 segundos por turno
const BONUS = 10;                // casillas extra al matar
const ORDER = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };
const EMOJIS = ['🔥', '👏', '😂', '😱', '🏆', '💀'];
const PUB = path.join(__dirname, 'public');
const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
  let url; try { url = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  const file = path.join(PUB, url === '/' ? 'index.html' : url);
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });
const rooms = new Map();

const code4 = () => Array.from({ length: 4 }, () => AL[Math.floor(Math.random() * AL.length)]).join('');
const d6 = () => 1 + Math.floor(Math.random() * 6);
const ringIdx = (ci, st) => (ci * 14 + 5 + st) % 56;       // válido para st 1..51
const onRing = st => st >= 1 && st <= RING;
const cur = r => r.seats[r.cur];
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const note = (r, text) => { r.notice = { n: r.notice.n + 1, text }; };

// ---- reglas ----
function houseOcc(r) {
  const o = new Set();
  r.seats.forEach(q => q.steps.forEach((st, j) => {
    if (q.inH[j]) { const x = ringIdx(q.ci, st); o.add(Math.floor(x / 14) * 10 + (x % 14) - 5); }
  }));
  return o;
}

function branchSide(ci, s) {
  if (s === 0) return ci;
  if (s >= 1 && s <= 50) { const x = ringIdx(ci, s); if (x % 14 === 5) return Math.floor(x / 14); }
  return -1;
}

// Víctimas al caer en el paso t del carril normal (Regla 8: en st === 51 / casilla 9 propia tras dar la vuelta ya no te matan)
function victims(r, p, t) {
  if (!onRing(t)) return [];
  const idx = ringIdx(p.ci, t), v = [];
  r.seats.forEach(q => {
    if (q === p) return;
    q.steps.forEach((s, j) => {
      if (onRing(s) && s < RING && !q.inH[j] && ringIdx(q.ci, s) === idx) v.push([q, j]);
    });
  });
  return v;
}
function hitAll(r, p, t) {
  const v = victims(r, p, t);
  v.forEach(([q, j]) => { q.steps[j] = -1; q.inH[j] = false; });
  return v.length;
}

// Regla 6: Avanzando con dados solo puedes hacer torre de máximo 2 fichas propias
function ownStackCount(p, to, inH) {
  if (to <= 0 || to >= END) return 0;
  let c = 0;
  p.steps.forEach((s, j) => { if (s === to && p.inH[j] === inH) c++; });
  return c;
}

// Rutas posibles de una ficha con un valor: n = carril normal, h = casa
function routes(r, p, i, val) {
  const st = p.steps[i], to = st + val, out = {};
  if (st < 0 || st >= END || to > END) return out;
  const O = houseOcc(r);
  const free = (side, a, b) => { for (let c = a; c <= b; c++) if (O.has(side * 10 + c)) return false; return true; };
  const land = inH => ({ to, inH, kills: inH ? 0 : victims(r, p, to).length });

  if (p.inH[i]) {                                   // ya va dentro de una casa (1 al 7)
    const x = ringIdx(p.ci, st), side = Math.floor(x / 14), n = (x % 14) - 5;
    if (!free(side, n + 1, Math.min(n + val, 7))) return out;
    const stayInH = n + val <= 7;
    if (!stayInH && ownStackCount(p, to, false) >= 2) return out;
    out.h = land(stayInH);
    return out;
  }
  if (ownStackCount(p, to, false) < 2) {
    out.n = land(false);
  }
  for (let j = 0; j < val; j++) {                   // ¿pasa por la entrada de alguna casa?
    const side = branchSide(p.ci, st + j);
    if (side < 0) continue;
    const rem = val - j;
    const stayInH = rem <= 7;
    if (free(side, 1, Math.min(rem, 7)) && (stayInH || ownStackCount(p, to, false) < 2)) {
      out.h = land(stayInH);
    }
    break;
  }
  return out;
}

// Números para sembrar: (3,3), (6,3), (4,2), (6,6), (5,1)
function enterOpt(r) {
  if (r.bonus || r.used[0] || r.used[1]) return null;
  const p = cur(r);
  const base = p.steps.map((s, i) => s === -1 ? i : -1).filter(i => i >= 0);
  if (!base.length) return null;
  const [a, b] = r.dice;
  // Regla 6: al sembrar puedes hacer torre de hasta 3 fichas en el mismo lugar
  const atZero = p.steps.filter(s => s === 0).length;
  const atThree = p.steps.filter((s, idx) => s === 3 && !p.inH[idx]).length;

  if (a === 6 && b === 6) {
    const canSeed = Math.min(2, base.length, 3 - atZero);
    return canSeed > 0 ? { i: base[0], n: canSeed, target: 0 } : null;     // doble 6 siembra doble en casilla 0
  }
  if (a + b === 6) {                                                        // (3,3), (4,2), (5,1)
    return atZero < 3 ? { i: base[0], n: 1, target: 0 } : null;
  }
  if ((a === 6 && b === 3) || (a === 3 && b === 6)) {                       // (6,3)
    return atThree < 3 ? { i: base[0], n: 1, target: 3 } : null;
  }
  return null;
}

function amounts(r) {
  if (r.bonus) return [{ key: 'b', use: [], val: BONUS, bonus: true }];
  const l = [];
  if (!r.used[0]) l.push({ key: '0', use: [0], val: r.dice[0] });
  if (!r.used[1]) l.push({ key: '1', use: [1], val: r.dice[1] });
  if (!r.used[0] && !r.used[1]) l.push({ key: 's', use: [0, 1], val: r.dice[0] + r.dice[1], sum: true });
  return l;
}

function pieceOpts(r, p, a) {
  const l = [];
  p.steps.forEach((s, i) => { const rt = routes(r, p, i, a.val); if (Object.keys(rt).length) l.push({ i, rt }); });
  return l;
}

// Detecta qué fichas tienen posibilidad de matar en este momento
function getKillers(r, p) {
  const killers = new Set();
  const e = enterOpt(r);
  if (e && e.target && victims(r, p, e.target).length > 0) killers.add(e.i);
  amounts(r).forEach(a => {
    pieceOpts(r, p, a).forEach(po => {
      if (Object.values(po.rt).some(res => res.kills > 0)) killers.add(po.i);
    });
  });
  return [...killers];
}

const anyLegal = r => !!enterOpt(r) || amounts(r).some(a => pieceOpts(r, cur(r), a).length);

// ---- turnos ----
function startTurn(r, prefix) {
  clearTimeout(r.timer);
  r.phase = 'roll'; r.dice = [0, 0]; r.used = [false, false]; r.bonus = 0;
  r.msg = (prefix ? prefix + ' · ' : '') + 'Turno de ' + cur(r).name;
  r.deadline = Date.now() + TURN_MS;
  r.timer = setTimeout(() => timeUp(r), TURN_MS);
}
function timeUp(r) {
  if (r.phase !== 'roll' && r.phase !== 'move') return;
  const name = cur(r).name;
  note(r, `Se acabó el tiempo de ${name}`);
  advance(r, `Tiempo agotado para ${name}`);
}
function advance(r, prefix) {
  clearTimeout(r.timer); r.timer = null; r.deadline = 0;
  let extra = prefix || '';
  for (let k = 0; k < r.seats.length; k++) {
    r.cur = (r.cur + 1) % r.seats.length;
    const s = cur(r);
    if (!s.on || s.spec) continue;
    if (s.skip) {                                      // Regla 9: pierde turno por tirar cuando no le tocaba
      s.skip = false;
      extra = (extra ? extra + ' · ' : '') + `${s.name} pierde su turno por castigo`;
      continue;
    }
    startTurn(r, extra);
    return broadcast(r);
  }
  r.phase = 'wait'; r.msg = 'Esperando a que vuelva algún jugador';
  broadcast(r);
}
function pause(r, ms, prefix) {
  clearTimeout(r.timer); r.deadline = 0;
  r.timer = setTimeout(() => advance(r, prefix), ms);
}

// ---- estado ----
function broadcast(r) {
  let legal = null;
  if (r.phase === 'move') {
    const e = enterOpt(r), p = cur(r);
    legal = {
      enter: e ? { i: e.i, n: e.n, kills: e.target ? victims(r, p, e.target).length : 0 } : null,
      bonus: !!r.bonus,
      amts: amounts(r).map(a => ({ key: a.key, val: a.val, sum: !!a.sum, bonus: !!a.bonus, pieces: pieceOpts(r, p, a) }))
    };
  }
  const left = r.deadline && (r.phase === 'roll' || r.phase === 'move') ? Math.max(0, r.deadline - Date.now()) : 0;
  r.seats.forEach((s, idx) => send(s.ws, {
    t: 'state', code: r.code, you: idx, id: s.id, phase: r.phase, cur: r.cur,
    dice: r.dice, used: r.used, msg: r.msg, legal, left, notice: r.notice,
    players: r.seats.map(q => ({ name: q.name, ci: q.ci, steps: q.steps, inH: q.inH, on: q.on, place: q.place || 0, spec: !!q.spec }))
  }));
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
        room = { code: c, seats: [], phase: 'lobby', cur: 0, dice: [0, 0], used: [false, false], bonus: 0, msg: '', timer: null, gc: null, deadline: 0, notice: { n: 0, text: '' } };
        rooms.set(c, room);
      } else {
        room = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!room) return fail('No existe esa sala');
      }
      clearTimeout(room.gc);
      let seat = m.id && room.seats.find(s => s.id === m.id);
      if (seat) { seat.ws = ws; seat.on = true; }
      else {
        if (room.phase !== 'lobby') return fail('La partida ya empezó');
        if (room.seats.length >= 4) return fail('La sala está llena');
        seat = {
          id: crypto.randomBytes(8).toString('hex'), name: String(m.name || 'Jugador').slice(0, 14), ci: room.seats.length,
          steps: [-1, -1, -1, -1], inH: [false, false, false, false], place: 0, spec: false, skip: false, fx: 0, ws, on: true
        };
        room.seats.push(seat);
      }
      ws.room = room; ws.seat = seat;
      if (room.phase === 'wait' && !room.timer) return advance(room);
      return broadcast(room);
    }
    if (!r) return;

    if (m.t === 'start' && (r.phase === 'lobby' || r.phase === 'over')) {
      if (r.phase === 'lobby' && r.seats[0] !== ws.seat) return;
      r.seats = r.seats.filter(s => s.on);
      const n = r.seats.length; if (n < 2) return fail('Se necesitan al menos 2 jugadores');
      r.seats.forEach((s, k) => {
        s.ci = ORDER[n][k]; s.steps = [-1, -1, -1, -1]; s.inH = [false, false, false, false];
        s.place = 0; s.spec = false; s.skip = false;
      });
      r.cur = 0; startTurn(r); r.msg = 'Empieza ' + cur(r).name;
      return broadcast(r);
    }

    if ((m.t === 'react' || m.t === 'say') && ws.seat.spec && r.phase !== 'lobby') {
      const now = Date.now(); if (now - ws.seat.fx < 500) return; ws.seat.fx = now;
      let v;
      if (m.t === 'react') { if (!EMOJIS.includes(m.v)) return; v = m.v; }
      else { v = String(m.v || '').replace(/\s+/g, ' ').trim().slice(0, 40); if (!v) return; }
      r.seats.forEach(s => send(s.ws, { t: 'fx', kind: m.t === 'react' ? 'emoji' : 'text', name: ws.seat.name, v }));
      return;
    }

    // Regla 9: Si alguien tira fuera de su turno, pierde su próximo turno
    if (m.t === 'roll' && r.phase !== 'lobby' && r.phase !== 'over') {
      if (cur(r) !== ws.seat) {
        if (!ws.seat.spec && !ws.seat.skip) {
          ws.seat.skip = true;
          note(r, `¡Castigo! ${ws.seat.name} tiró fuera de turno y perderá su siguiente turno.`);
          broadcast(r);
        }
        return;
      }
      if (r.phase !== 'roll') return;
      const p = ws.seat;
      r.dice = [d6(), d6()]; r.used = [false, false]; r.bonus = 0;
      r.rollSnap = {
        steps: [...p.steps],
        inH: [...p.inH],
        killers: [],
        movedPieces: new Set(),
        didKill: false
      };
      r.rollSnap.killers = getKillers(r, p);
      r.msg = `${p.name} sacó ${r.dice[0]} y ${r.dice[1]}` + (r.dice[0] === r.dice[1] ? ' (¡Pares!)' : '');
      if (anyLegal(r)) r.phase = 'move';
      else {
        if (r.dice[0] === r.dice[1]) {                 // Regla 7: Pares vuelve a tirar
          r.phase = 'roll';
          r.msg += ' · sin movimientos, pero sacó pares y vuelve a tirar';
        } else {
          r.phase = 'wait'; r.msg += ' · sin movimientos'; pause(r, 1600);
        }
      }
      return broadcast(r);
    }

    if (m.t === 'move' && r.phase === 'move' && cur(r) === ws.seat) {
      const p = ws.seat, i = m.i | 0; if (i < 0 || i > 3) return;
      let txt, n = 0;
      if (m.key === 'e') {
        const o = enterOpt(r); if (!o || p.steps[i] !== -1) return;
        const idxs = [i].concat(p.steps.map((s, j) => (s === -1 && j !== i) ? j : -1).filter(j => j >= 0)).slice(0, o.n);
        idxs.forEach(j => { p.steps[j] = o.target; p.inH[j] = false; if (r.rollSnap) r.rollSnap.movedPieces.add(j); });
        r.used = [true, true];
        n = o.target ? hitAll(r, p, o.target) : 0;
        txt = o.n === 2 ? 'siembra 2 fichas a la vez' : o.target ? 'saca una ficha a la casilla 3' : 'siembra una ficha en casilla 0';
      } else {
        const a = amounts(r).find(x => x.key === m.key); if (!a) return;
        const rt = routes(r, p, i, a.val), ks = Object.keys(rt);
        const k = rt[m.route] ? m.route : (ks.length === 1 ? ks[0] : null);
        if (!k) return;
        const res = rt[k];
        p.steps[i] = res.to; p.inH[i] = res.inH;
        if (r.rollSnap) r.rollSnap.movedPieces.add(i);
        a.use.forEach(u => { r.used[u] = true; });
        if (a.bonus) r.bonus = 0;
        n = res.inH ? 0 : hitAll(r, p, res.to);
        txt = (a.bonus ? 'avanza los +' + BONUS + ' del bono' : res.to === END ? 'libera una ficha' : 'mueve ' + a.val) + (k === 'h' && res.inH ? ' por la casa' : '');
      }

      // Regla 2 y 3: Si matas te dan +10 obligatorios primero; si no puedes avanzar los 10, tampoco puedes avanzar lo que te sobró del otro dado
      if (n > 0) {
        if (r.rollSnap) r.rollSnap.didKill = true;
        r.bonus = BONUS;
        const canUseBonus = amounts(r).some(a => pieceOpts(r, p, a).length > 0);
        if (!canUseBonus) {
          r.bonus = 0;
          r.used = [true, true]; // bloquea también el dado restante (Regla 3)
          note(r, `${p.name} mató pero no tiene espacio para avanzar los +10 puntos; pierde el avance restante.`);
        }
      }

      r.msg = `${p.name} ${txt}` + (n ? ` y manda ${n} ${n > 1 ? 'fichas' : 'ficha'} a la celda` : '') + (r.bonus ? ` · ¡avanza primero tus +${BONUS}!` : '');

      if (p.steps.every(s => s === END)) {
        p.place = r.seats.filter(s => s.place).length + 1; p.spec = true; r.bonus = 0;
        r.msg = `${p.name} liberó sus 4 fichas y queda en ${p.place}° lugar`;
        const rest = r.seats.filter(s => !s.place);
        if (rest.length <= 1) {
          if (rest.length === 1) rest[0].place = p.place + 1;
          clearTimeout(r.timer); r.timer = null; r.deadline = 0; r.phase = 'over';
          r.msg = `Partida terminada · ${r.seats.find(s => s.place === 1).name} ganó`;
        } else { r.phase = 'wait'; pause(r, 2200); }
        return broadcast(r);
      }

      // Cuando ya terminó de usar sus movimientos de la tirada:
      if (!anyLegal(r)) {
        // Reglas 10 y 11: Si podía matar y no mató, se regresa a su base la ficha que no mató (y si movió 2 fichas, se revierten ambas y pierde turno)
        if (r.rollSnap && r.rollSnap.killers.length > 0 && !r.rollSnap.didKill) {
          const kIdx = r.rollSnap.killers[0];
          if (r.rollSnap.movedPieces.size >= 2) {
            p.steps = [...r.rollSnap.steps];
            p.inH = [...r.rollSnap.inH];
            if (p.steps[kIdx] >= 0) { p.steps[kIdx] = -1; p.inH[kIdx] = false; }
            note(r, `¡Soplado! ${p.name} no mató y movió dos fichas: se regresan sus fichas, la ficha ${kIdx + 1} va a la base y pierde el turno.`);
            r.phase = 'wait'; pause(r, 2200);
            return broadcast(r);
          } else {
            if (p.steps[kIdx] >= 0) { p.steps[kIdx] = -1; p.inH[kIdx] = false; }
            note(r, `¡Soplado! ${p.name} no quiso matar: su ficha ${kIdx + 1} regresa a la base.`);
          }
        }

        // Regla 7: Si sacó pares, vuelve a tirar hasta que dejen de tocar pares
        if (r.dice[0] === r.dice[1]) {
          r.phase = 'roll';
          r.dice = [0, 0]; r.used = [false, false]; r.bonus = 0;
          r.deadline = Date.now() + TURN_MS;
          clearTimeout(r.timer);
          r.timer = setTimeout(() => timeUp(r), TURN_MS);
          r.msg += ` · ¡Sacó pares, vuelve a tirar ${p.name}!`;
        } else {
          r.phase = 'wait'; pause(r, 1200);
        }
      }
      return broadcast(r);
    }
  });

  ws.on('close', () => {
    const r = ws.room, s = ws.seat;
    if (!r || !s || s.ws !== ws) return;
    s.on = false;
    if (r.phase === 'lobby') { r.seats = r.seats.filter(x => x !== s); r.seats.forEach((x, k) => x.ci = k); }
    if (!r.seats.some(x => x.on)) { clearTimeout(r.timer); r.timer = null; r.gc = setTimeout(() => rooms.delete(r.code), 10 * 60 * 1000); return; }
    if (r.phase !== 'lobby' && r.phase !== 'over' && cur(r) === s) return advance(r);
    broadcast(r);
  });
});

server.listen(PORT, () => console.log('Poliana lista en http://localhost:' + PORT));
