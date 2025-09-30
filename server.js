// server.js – F9R USB single-port (NMEA out + RTCM in) + NTRIP forward + GUI
// Node >= 18
//
// ENV override examples:
//   SERIAL_PATH=/dev/ttyACM1 SERIAL_BAUD=230400 node server.js
//   NTRIP_HOST=caster.kinoki.fr NTRIP_PORT=2101 NTRIP_MOUNT=CHAT NTRIP_USER=xxxxx NTRIP_PASS=xxxxxxx node server.js
//
// Front: sert / (index.html, app.js) via Express + Socket.IO (telemetry)

import fs from 'fs';
import path from 'path';
import http from 'http';
import express from 'express';
import { Server } from 'socket.io';
import net from 'net';
import { SerialPort } from 'serialport';



// ------------------------- Config -------------------------
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8080', 10);

const SERIAL_PATH = process.env.SERIAL_PATH || '/dev/ttyACM0';
const SERIAL_BAUD = parseInt(process.env.SERIAL_BAUD || '115200', 10);

const NTRIP_HOST  = process.env.NTRIP_HOST  || 'caster.kinoki.fr';
const NTRIP_PORT  = parseInt(process.env.NTRIP_PORT || '2101', 10);
const NTRIP_MOUNT = process.env.NTRIP_MOUNT || 'DEV';
const NTRIP_USER  = process.env.NTRIP_USER  || 'xxxxxx';
const NTRIP_PASS  = process.env.NTRIP_PASS  || 'xxxxxx';

// Envoi périodique de la dernière GGA au caster (certains VRS l’exigent)
const NTRIP_SEND_GGA = (process.env.NTRIP_SEND_GGA || 'true') === 'true';
const NTRIP_NMEA_INTERVAL_SEC = parseInt(process.env.NTRIP_NMEA_INTERVAL_SEC || '10', 10);

// ------------------------- State --------------------------
const state = {
  lastFix: null,                // résumé GGA/RMC
  track: [],                    // option: trace courte
  stats: { nmea: 0, bad: 0, gga: 0, rmc: 0, gsv: 0, gsa: 0 },
  serialIn: { path: SERIAL_PATH, baud: SERIAL_BAUD },
  ntrip: { connected: false, host: NTRIP_HOST, port: NTRIP_PORT, mount: NTRIP_MOUNT, bytes: 0, error: null, lastGGAUpTs: null },

  // Satellites
  sat: {
    gsvSeq: {},            // séquences GSV par talker (GP/GL/GA/GB)
    _talker: {},           // résumé consolidé par talker
    inView: 0,             // total "vus"
    tracked: 0,            // approx "suivis" (SNR>0)
    used: [],              // PRN utilisés (GSA)
    dop: { pdop: null, hdop: null, vdop: null },
    perConstellation: {
      GPS: { inView: 0, used: 0 },
      GLONASS: { inView: 0, used: 0 },
      GALILEO: { inView: 0, used: 0 },
      BEIDOU: { inView: 0, used: 0 },
      OTHER: { inView: 0, used: 0 }
    },
    _usedByConst: {
      GPS: new Set(), GLONASS: new Set(), GALILEO: new Set(), BEIDOU: new Set(), OTHER: new Set()
    }
  },

  // Index PRN -> constellation (alimenté par GSV)
  satIndexByPRN: new Map(),

  // Mémo dernière GGA brute (pour VRS)
  lastGGALine: null
};

// ------------------------- HTTP + WS ----------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Sert le dossier courant (index.html, app.js, etc.)
//app.use(express.static(path.join(process.cwd())));
app.use(express.static("public"));
app.use(express.json());

app.get('/status', (req, res) => {
  res.json({
    ok: true,
    serialIn: state.serialIn,
    ntrip: state.ntrip,
    lastFix: state.lastFix,
    sat: {
      inView: state.sat.inView,
      tracked: state.sat.tracked,
      used: state.sat.used,
      dop: state.sat.dop,
      perConstellation: {
        GPS: state.sat.perConstellation.GPS,
        GLONASS: state.sat.perConstellation.GLONASS,
        GALILEO: state.sat.perConstellation.GALILEO,
        BEIDOU: state.sat.perConstellation.BEIDOU,
        OTHER: state.sat.perConstellation.OTHER
      }
    }
  });
});

io.on('connection', (socket) => {
  socket.emit('hello', { ts: Date.now(), ntrip: state.ntrip });

  socket.on('ntripConnect', cfg => {
    const { host, port, mount, user, pass } = cfg || {};
    if (!host || !port || !mount) { state.ntrip.error = 'Missing host/port/mount'; broadcast(); return; }

    // MàJ de l'état + identifiants
    state.ntrip = {
      connected: false,
      host,
      port: parseInt(port, 10),
      mount,
      bytes: 0,
      error: null,
      lastGGAUpTs: null,
      user,            // AJOUT
      pass             // AJOUT
    };

    // Autorise la connexion (et d'éventuelles reconnexions) puis connecte
    ntripShouldRun = true;
    if (ntripRecoTimer) { clearTimeout(ntripRecoTimer); ntripRecoTimer = null; }
    connectNTRIP();
  });

  socket.on('ntripDisconnect', () => {
    // Interdire toute reconnexion automatique
    ntripShouldRun = false;

    // Stop timers (GGA périodique + reco)
    if (ntripTimer) { clearInterval(ntripTimer); ntripTimer = null; }
    if (ntripRecoTimer) { clearTimeout(ntripRecoTimer); ntripRecoTimer = null; }

    // Coupe la socket si ouverte
    try { ntripSock?.destroy(); } catch {}
    ntripSock = null;

    // État propre
    state.ntrip.connected = false;
    broadcast();
  });
});

function broadcast() {
  io.emit("telemetry", {
    ts: Date.now(),
    lastFix: state.lastFix,
    stats: state.stats,
    track: state.track,
    ntrip: state.ntrip,
    sat: state.sat
  });
}

setInterval(broadcast, 1000);

// ------------------------- Serial -------------------------
let serialInPort = null;
let serialLineBuf = '';

function openSerial() {
  return new Promise((resolve, reject) => {
    if (serialInPort?.isOpen) return resolve(serialInPort);
    serialInPort = new SerialPort({ path: SERIAL_PATH, baudRate: SERIAL_BAUD }, (err) => {
      if (err) return reject(err);
      log('[SERIAL] Opened', SERIAL_PATH, '@', SERIAL_BAUD);
      serialInPort.on('data', onSerialData);
      resolve(serialInPort);
    });
  });
}

function onSerialData(buf) {
  // Bufferise lignes NMEA
  const s = buf.toString('utf8');
  serialLineBuf += s;
  let idx;
  while ((idx = serialLineBuf.indexOf('\n')) >= 0) {
    const line = serialLineBuf.slice(0, idx).trim();
    serialLineBuf = serialLineBuf.slice(idx + 1);
    if (line.startsWith('$')) parseNMEA(line);
  }
}

// ------------------------- NMEA parsing -------------------
function checksumOK(line) {
  const star = line.indexOf('*');
  if (star < 0) return false;
  const payload = line.slice(1, star);
  const given = line.slice(star + 1).trim();
  let cs = 0;
  for (let i = 0; i < payload.length; i++) cs ^= payload.charCodeAt(i);
  const hex = cs.toString(16).toUpperCase().padStart(2, '0');
  return hex === given.toUpperCase();
}

function talkerOf(id) { return (id && id.slice(0,2)) || 'GN'; }
function constelFromTalker(t) {
  switch (t) { case 'GP': return 'GPS'; case 'GL': return 'GLONASS'; case 'GA': return 'GALILEO'; case 'GB': return 'BEIDOU'; default: return 'OTHER'; }
}
function recomputeUsedCounters() {
  const per = state.sat.perConstellation;
  for (const k of Object.keys(per)) per[k].used = 0;
  const globalUsed = new Set();
  for (const [k,setv] of Object.entries(state.sat._usedByConst)) {
    per[k].used = setv.size; setv.forEach(prn => globalUsed.add(prn));
  }
  state.sat.used = Array.from(globalUsed);
}

function dmToDeg(dm, hemi) {
  if (!dm || !hemi) return null;
  const v = parseFloat(dm);
  if (!Number.isFinite(v)) return null;
  const d = Math.floor(v / 100);
  const m = v - d * 100;
  let deg = d + m / 60;
  if (hemi === 'S' || hemi === 'W') deg = -deg;
  return deg;
}

function handleGGA(parts) {
  // $GxGGA,time,lat,NS,lon,EW,fix,satsUsed,hdop,alt,M,geoid,M,age,refId
  const lat = dmToDeg(parts[2], parts[3]);
  const lon = dmToDeg(parts[4], parts[5]);
  const fix = parseInt(parts[6] || '0', 10);
  const satsUsed = parseInt(parts[7] || '0', 10);
  const hdop = parseFloat(parts[8] || 'NaN');
  const alt = parseFloat(parts[9] || 'NaN');
  const age = parts[13] ? parseFloat(parts[13]) : null;
  const refId = parts[14] ? parts[14].split('*')[0] : null;

  state.lastFix = {
    ...(state.lastFix || {}),
    lat, lon, fix, satsUsed, hdop, alt,
    ageCorrections: Number.isFinite(age) ? age : null,
    refStationId: refId || null
  };

  // GGA brute pour VRS
  const star = parts.join(',').indexOf('*');
  // Reconstituer la ligne originale (plus simple : on mémorise la dernière ligne valide dans parseNMEA)
}

function handleRMC(parts) {
  // $GxRMC,time,status,lat,NS,lon,EW,speed,cog,date,...
  const lat = dmToDeg(parts[3], parts[4]);
  const lon = dmToDeg(parts[5], parts[6]);
  state.lastFix = { ...(state.lastFix || {}), lat: (lat ?? state.lastFix?.lat), lon: (lon ?? state.lastFix?.lon) };
}

function handleGSV(parts) {
  // $GxGSV,totalMsgs,msgIdx,totalInView,(PRN,Elev,Az,SNR)...
  const talker = parts[0].slice(0, 2); // "GP","GL","GA","GB",...
  let C = "OTHER";
  if (talker === "GP") C = "GPS";
  else if (talker === "GL") C = "GLONASS";
  else if (talker === "GA") C = "GALILEO";
  else if (talker === "GB") C = "BEIDOU";
                                                                                      
  const totalMsgs   = parseInt(parts[1] || '1', 10);
  const msgIdx      = parseInt(parts[2] || '1', 10);
  const totalInView = parseInt(parts[3] || '0', 10);

  const seq = state.sat.gsvSeq[talker] || { totalMsgs, got: {}, list: [], totalInView: 0 };
  seq.totalMsgs   = totalMsgs;
  seq.totalInView = totalInView;
  seq.got[msgIdx] = true;

  for (let i = 4; i + 3 < parts.length; i += 4) {
    const prn  = parts[i] && parts[i].trim();
    const elev = parseInt(parts[i+1] || 'NaN', 10);
    const az   = parseInt(parts[i+2] || 'NaN', 10);
    const snr  = parseInt(parts[i+3] || 'NaN', 10);
    if (prn) {
      seq.list.push({ prn, elev, az, snr });
      state.satIndexByPRN.set(String(prn), C);
    //state.sat.satIndexByPRN.set(String(prn), C); // index PRN -> constellation
    }
  }
  state.sat.gsvSeq[talker] = seq;

  if (Object.keys(seq.got).length === seq.totalMsgs) {
    const inView  = seq.totalInView || seq.list.length;
    const tracked = seq.list.filter(s => Number.isFinite(s.snr) && s.snr > 0).length;

    state.sat._talker[talker] = { inView, tracked };
    state.sat.perConstellation[C].inView = inView;

    // totaux
    let totalInViewAll = 0, totalTrackedAll = 0;
    for (const t of Object.values(state.sat._talker)) {
      totalInViewAll += t.inView || 0;
      totalTrackedAll += t.tracked || 0;
    }
    state.sat.inView  = totalInViewAll;
    state.sat.tracked = totalTrackedAll;
    // rétro compat
    state.lastFix = { ...(state.lastFix || {}), satsInView: state.sat.inView };

    // reset
    state.sat.gsvSeq[talker] = { totalMsgs: 0, got: {}, list: [], totalInView: 0 };
  }
}

function handleGSA(parts) {
  // $GxGSA,modeSel,fixType,s1..s12,PDOP,HDOP,VDOP
  const talker = talkerOf(parts[0]);
  const usedNow = [];
  for (let i = 3; i <= 14; i++) {
    const v = parts[i] && parts[i].trim();
    if (v) usedNow.push(v);
  }

  const pdop = parseFloat(parts[15] || 'NaN');
  const hdop = parseFloat(parts[16] || 'NaN');
  const vdop = parseFloat(parts[17] || 'NaN');
  state.sat.dop = {
    pdop: Number.isFinite(pdop) ? pdop : state.sat.dop.pdop,
    hdop: Number.isFinite(hdop) ? hdop : state.sat.dop.hdop,
    vdop: Number.isFinite(vdop) ? vdop : state.sat.dop.vdop
  };

  const assign = (constel, prn) => state.sat._usedByConst[constel].add(prn);
  const specificConstel = constelFromTalker(talker);

  for (const prn of usedNow) {
    let C = null;
    if (specificConstel && specificConstel !== 'OTHER') {
      C = specificConstel;
    } else {
      C = state.satIndexByPRN.get(String(prn)) || null;
      //C = state.sat.satIndexByPRN.get(String(prn)) || null;
      if (!C) {
        const id = parseInt(prn, 10);
        if (id >= 1 && id <= 32) C = 'GPS';
        else if (id >= 65 && id <= 96) C = 'GLONASS';
        else if (id >= 201 && id <= 237) C = 'BEIDOU';
        else if ((id >= 301 && id <= 336) || (id >= 1 && id <= 36)) C = 'GALILEO'; // Galileo 1–36 fallback
        else C = 'OTHER';
      }
    }
    assign(C, prn);
  }
  recomputeUsedCounters();
}

function parseNMEA(line) {
  if (!checksumOK(line)) { state.stats.bad++; return; }
  state.stats.nmea++;
  state._lastNMEALine = line; // pour debug

  // Mémorise la dernière GGA brute pour VRS
  if (line.includes('GGA')) state.lastGGALine = line;

  const star = line.indexOf('*');
  const core = line.slice(1, star);
  const parts = core.split(',');
  const type = parts[0].slice(2);

  if (type === 'GGA') { state.stats.gga++; handleGGA(parts); }
  else if (type === 'RMC') { state.stats.rmc++; handleRMC(parts); }
  else if (type === 'GSV') { state.stats.gsv++; handleGSV(parts); }
  else if (type === 'GSA') { state.stats.gsa++; handleGSA(parts); }
}

// ------------------------- NTRIP --------------------------
let ntripSock = null;
let ntripHeaderParsed = false;
let ntripHeaderBuf = '';
let ntripTimer = null;
    
// AJOUT : contrôle de (re)connexion piloté par la GUI
let ntripShouldRun = false;     // true = autoriser connexion/reconnexion ; false = rester déconnecté
let ntripRecoTimer = null;      // timer de reconnexion différée
    
function connectNTRIP() {
    if (!ntripShouldRun) return;
    
  ntripHeaderParsed = false;
  ntripHeaderBuf = '';

  const auth = Buffer.from(`${NTRIP_USER}:${NTRIP_PASS}`).toString('base64');
  const req =
    `GET /${encodeURIComponent(NTRIP_MOUNT)} HTTP/1.1\r\n` +
    `Host: ${NTRIP_HOST}\r\n` +
    `Ntrip-Version: Ntrip/2.0\r\n` +
    `User-Agent: KinoCaster/usb-single\r\n` +
    `Connection: close\r\n` +
    `Authorization: Basic ${auth}\r\n\r\n`;

  log('[NTRIP] Connecting to', `${NTRIP_HOST}:${NTRIP_PORT}`, 'mount', NTRIP_MOUNT);
  ntripSock = net.createConnection({ host: NTRIP_HOST, port: NTRIP_PORT }, async () => {
    try { await openSerial(); } catch (e) { log('[SERIAL] Open error:', e.message); }
    ntripSock.write(req);
  });

  ntripSock.on('data', (chunk) => {
    if (!ntripHeaderParsed) {
      ntripHeaderBuf += chunk.toString('utf8');
      const idx = ntripHeaderBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;

      const header = ntripHeaderBuf.slice(0, idx);
      const rest = Buffer.from(ntripHeaderBuf.slice(idx + 4), 'binary');

      if (header.startsWith('ICY 200') || header.startsWith('HTTP/1.0 200') || header.startsWith('HTTP/1.1 200')) {
        log('[NTRIP] 200 OK — streaming RTCM');
        state.ntrip.connected = true;
        state.ntrip.error = null;
        ntripHeaderParsed = true;
        ntripHeaderBuf = '';

        if (rest.length && serialInPort?.isOpen) {
          try { serialInPort.write(rest); state.ntrip.bytes += rest.length; } catch (_) {}
        }

        // Envoi périodique de la GGA au caster (si activé)
        if (NTRIP_SEND_GGA && !ntripTimer) {
          ntripTimer = setInterval(() => {
            if (!state.lastGGALine) return;
            try {
              // Format NTRIP: chaque NMEA en CRLF
              const line = state.lastGGALine.trim();
              const payload = line.endsWith('\r\n') ? line : (line + '\r\n');
              ntripSock.write(payload);
              state.ntrip.lastGGAUpTs = Date.now();
            } catch {}
          }, NTRIP_NMEA_INTERVAL_SEC * 1000);
        }

      } else {
        log('[NTRIP] Unexpected response:\n' + header);
        ntripSock.destroy();
      }
      return;
    }

    // Après l’en-tête => payload RTCM
    if (serialInPort?.isOpen) {
      try { serialInPort.write(chunk); state.ntrip.bytes += chunk.length; } catch (_) {}
    }
  });

  ntripSock.on('error', (err) => {
    state.ntrip.error = err.message;
    log('[NTRIP] Error:', err.message);
  });

    ntripSock.on('close', () => {
      log('[NTRIP] Closed');
      state.ntrip.connected = false;

      if (ntripTimer) { clearInterval(ntripTimer); ntripTimer = null; }
      if (ntripRecoTimer) { clearTimeout(ntripRecoTimer); ntripRecoTimer = null; }

      // Reconnexion uniquement si demandé par la GUI
      if (ntripShouldRun) {
        ntripRecoTimer = setTimeout(() => {
          ntripRecoTimer = null;
          connectNTRIP();
        }, 3000);
      }
    });

}

// ------------------------- Boot --------------------------
function log(...a) { console.log(new Date().toISOString(), ...a); }

server.listen(HTTP_PORT, () => {
  log(`[HTTP] Listening on :${HTTP_PORT}`);
  openSerial().catch(e => log('[BOOT] serial open failed:', e.message));
});
