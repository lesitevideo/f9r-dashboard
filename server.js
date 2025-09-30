// server.js — F9R Dashboard (Node.js + Express + Socket.IO)
// Lit /dev/serial0 @ 38400, parse NMEA (GGA/RMC/GSV), diffuse la télémétrie,
// NTRIP client + rediffusion série + envoi périodique d'une trame NMEA GGA au caster

import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { SerialPort } from "serialport";
import * as dotenv from "dotenv";
import net from "net";

dotenv.config();

const SERIAL_PATH = process.env.SERIAL_PATH || "/dev/serial0";
const SERIAL_BAUD = parseInt(process.env.SERIAL_BAUD || "38400", 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || "8080", 10);

// Intervalle d'envoi GGA vers le caster (en secondes)
const NTRIP_NMEA_INTERVAL_SEC = parseInt(process.env.NTRIP_NMEA_INTERVAL_SEC || "10", 10); // 5–60 recommandé

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: "*" } });

app.use(express.static("public"));
app.use(express.json());

// -------------------- Helpers NMEA --------------------
function checksumOK(nmea) {
  const star = nmea.indexOf("*");
  if (star === -1) return false;
  const data = nmea.slice(1, star);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum ^= data.charCodeAt(i);
  const hex = sum.toString(16).toUpperCase().padStart(2, "0");
  const chk = nmea.slice(star + 1, star + 3).toUpperCase();
  return hex === chk;
}

function dmToDeg(dmStr, hemi) {
  if (!dmStr) return null;
  const dot = dmStr.indexOf(".");
  const degLen = (dot > 2) ? (dot - 2) : (dmStr.length - 2);
  const deg = parseInt(dmStr.slice(0, degLen), 10);
  const min = parseFloat(dmStr.slice(degLen));
  let dec = deg + (min / 60);
  if (hemi === "S" || hemi === "W") dec = -dec;
  return dec;
}

function toDM(value, isLat) {
  if (value == null) return { dm: null, hemi: null };
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  const degWidth = isLat ? 2 : 3;
  const degStr = String(deg).padStart(degWidth, "0");
  const minStr = min.toFixed(4).padStart(7, "0");
  const dm = `${degStr}${minStr}`;
  const hemi = isLat ? (value >= 0 ? "N" : "S") : (value >= 0 ? "E" : "W");
  return { dm, hemi };
}

function nmeaChecksum(sentenceNoDollar) {
  let sum = 0;
  for (let i = 0; i < sentenceNoDollar.length; i++) sum ^= sentenceNoDollar.charCodeAt(i);
  return sum.toString(16).toUpperCase().padStart(2, "0");
}

function buildGGAfromState() {
  const f = state.lastFix || {};
  if (f.lat == null || f.lon == null) return null;
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  const time = `${hh}${mm}${ss}.00`;
  const latDM = toDM(f.lat, true);
  const lonDM = toDM(f.lon, false);
  const fixQ = Number.isInteger(f.fix) ? f.fix : 1; // 1 si inconnu
  const sats = Number.isInteger(f.satsUsed) ? f.satsUsed : 12;
  const hdop = (typeof f.hdop === "number" && !Number.isNaN(f.hdop)) ? f.hdop.toFixed(2) : "1.0";
  const alt = (typeof f.alt === "number" && !Number.isNaN(f.alt)) ? f.alt.toFixed(1) : "0.0";
  const geoid = "0.0";
  const core = `GPGGA,${time},${latDM.dm},${latDM.hemi},${lonDM.dm},${lonDM.hemi},${fixQ},${sats},${hdop},${alt},M,${geoid},M,,`;
  const chk = nmeaChecksum(core);
  return `$${core}*${chk}\r\n`;
}

// -------------------- État --------------------
const state = {
  lastFix: null,
  track: [],
  stats: { nmea: 0, bad: 0, gga: 0, rmc: 0, gsv: 0 },
  serialIn: { path: SERIAL_PATH, baud: SERIAL_BAUD },
  serialOut: { path: null, baud: null, enabled: false, forwardCorrections: true },
  ntrip: { connected: false, host: null, port: null, mount: null, bytes: 0, error: null }
};

let serialInPort = new SerialPort({ path: SERIAL_PATH, baudRate: SERIAL_BAUD });
let serialOutPort = null;
let ntripSocket = null;
let ntripNmeaTimer = null; // timer d'envoi périodique GGA

// -------------------- Parsers NMEA --------------------
function handleGGA(parts) {
  // $GxGGA,time,lat,NS,lon,EW,fix,satsUsed,hdop,alt,M,...
  const lat = dmToDeg(parts[2], parts[3]);
  const lon = dmToDeg(parts[4], parts[5]);
  const fix = parseInt(parts[6] || "0", 10);
  const satsUsed = parseInt(parts[7] || "0", 10);
  const hdop = parseFloat(parts[8] || "0");
  const alt = parseFloat(parts[9] || "0");
  if (lat && lon) {
    state.lastFix = { ...(state.lastFix || {}), lat, lon, alt, satsUsed, hdop, fix };
    if (!state.track.length || (Math.abs(state.track[state.track.length - 1][0] - lat) > 1e-6 || Math.abs(state.track[state.track.length - 1][1] - lon) > 1e-6)) {
      state.track.push([lat, lon]);
      if (state.track.length > 5000) state.track.shift();
    }
  }
}

function handleRMC(parts) {
  // $GxRMC,time,status,lat,NS,lon,EW,speed(kn),course(deg),date,...
  const status = parts[2];
  const lat = dmToDeg(parts[3], parts[4]);
  const lon = dmToDeg(parts[5], parts[6]);
  const speedKn = parseFloat(parts[7] || "0");
  const course = parseFloat(parts[8] || "0");
  const timeUTC = parts[1];
  if (status === "A") {
    const speedKmh = speedKn * 1.852;
    const fixTime = timeUTC || null;
    state.lastFix = { ...(state.lastFix || {}), lat, lon, speed: speedKmh, course, time: fixTime };
    if (lat && lon) {
      if (!state.track.length || (Math.abs(state.track[state.track.length - 1][0] - lat) > 1e-6 || Math.abs(state.track[state.track.length - 1][1] - lon) > 1e-6)) {
        state.track.push([lat, lon]);
        if (state.track.length > 5000) state.track.shift();
      }
    }
  }
}

function handleGSV(parts) {
  // $GxGSV,totalMsgs,msgIdx,totalInView, ...
  const totalInView = parseInt(parts[3] || "0", 10);
  if (!Number.isNaN(totalInView)) {
    state.lastFix = { ...(state.lastFix || {}), satsInView: totalInView };
  }
}

function parseNMEA(line) {
  if (!line.startsWith("$") || !checksumOK(line)) { state.stats.bad++; return; }
  state.stats.nmea++;
  const star = line.indexOf("*");
  const core = line.slice(1, star);
  const parts = core.split(",");
  const type = parts[0].slice(2);
  if (type === "GGA") { state.stats.gga++; handleGGA(parts); }
  else if (type === "RMC") { state.stats.rmc++; handleRMC(parts); }
  else if (type === "GSV") { state.stats.gsv++; handleGSV(parts); }
}

// -------------------- Broadcast UI --------------------
function broadcast() {
  io.emit("telemetry", {
    ts: Date.now(),
    lastFix: state.lastFix,
    stats: state.stats,
    track: state.track,
    serial: state.serialIn,
    serialOut: state.serialOut,
    ntrip: state.ntrip
  });
}

// -------------------- Serial IN (F9R) --------------------
let buffer = "";
serialInPort.on("data", chunk => {
  const text = chunk.toString("utf8");
  buffer += text;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    // Rediffusion NMEA vers le port série OUT
    if (state.serialOut.enabled && serialOutPort && line.startsWith("$")) {
      try { serialOutPort.write(line + "\r\n"); } catch (e) {}
    }
    parseNMEA(line);
  }
});

serialInPort.on("open", () => { console.log(`[Serial-IN] ${SERIAL_PATH} @ ${SERIAL_BAUD}`); });
serialInPort.on("error", err => { console.error("[Serial-IN]", err.message); });

// -------------------- NTRIP (client) --------------------
function startNtripNmeaTimer() {
  if (ntripNmeaTimer) { clearInterval(ntripNmeaTimer); ntripNmeaTimer = null; }
  if (!state.ntrip.connected) return;
  const interval = Math.max(5, Math.min(60, NTRIP_NMEA_INTERVAL_SEC)) * 1000;
  ntripNmeaTimer = setInterval(() => {
    if (!ntripSocket) return;
    const gga = buildGGAfromState();
    if (gga) {
      try { ntripSocket.write(gga); } catch (_) {}
    }
  }, interval);
}

io.on("connection", socket => {
  socket.emit("hello", { serial: state.serialIn, serialOut: state.serialOut, ntrip: state.ntrip });

  // ---- Sortie série locale ----
  socket.on("configureSerialOut", cfg => {
    const { path, baud, enabled, forwardCorrections } = cfg || {};
    state.serialOut.enabled = !!enabled;
    state.serialOut.forwardCorrections = forwardCorrections !== false;
    if (!path || !baud || !enabled) {
      if (serialOutPort) { try { serialOutPort.close(); } catch (e) {} serialOutPort = null; }
      state.serialOut.path = null; state.serialOut.baud = null; broadcast(); return;
    }
    if (serialOutPort) { try { serialOutPort.close(); } catch (e) {} serialOutPort = null; }
    state.serialOut.path = path; state.serialOut.baud = parseInt(baud, 10);
    serialOutPort = new SerialPort({ path, baudRate: state.serialOut.baud }, err => {
      if (err) { console.error("[Serial-OUT] open error:", err.message); state.serialOut.enabled = false; }
      broadcast();
    });
  });

  // ---- Connexion NTRIP ----
  socket.on("ntripConnect", cfg => {
    const { host, port, mount, user, pass } = cfg || {};
    if (!host || !port || !mount) { state.ntrip.error = "Missing host/port/mount"; broadcast(); return; }
    if (ntripSocket) { try { ntripSocket.destroy(); } catch (e) {} ntripSocket = null; }
    state.ntrip = { connected: false, host, port, mount, bytes: 0, error: null };

    ntripSocket = net.createConnection({ host, port: parseInt(port, 10) }, () => {
      const auth = (user && pass) ? Buffer.from(`${user}:${pass}`).toString("base64") : null;
      const headers = [
        `GET /${mount} HTTP/1.1`,
        `Host: ${host}`,
        `User-Agent: F9R-Dashboard/0.1`,
        `Ntrip-Version: Ntrip/2.0`,
        auth ? `Authorization: Basic ${auth}` : null,
        `Connection: keep-alive`,
        "\r\n"
      ].filter(Boolean).join("\r\n");
      try { ntripSocket.write(headers); } catch (_) {}
      // Envoi initial d'une GGA dès la connexion TCP
      const gga = buildGGAfromState();
      if (gga) { try { ntripSocket.write(gga); } catch (_) {} }
    });

    let headerBuf = ""; let streaming = false;

    ntripSocket.on("data", data => {
      if (!streaming) {
        headerBuf += data.toString("utf8");
        const sep = headerBuf.indexOf("\r\n\r\n");
        if (sep >= 0) {
          const header = headerBuf.slice(0, sep);
          streaming = /(200 OK|ICY 200 OK)/i.test(header);
          if (!streaming) {
            state.ntrip.error = header.split("\n")[0].trim();
            try { ntripSocket.destroy(); } catch (_) {}
            broadcast();
            return;
          }
          // Connexion validée → démarrer le timer GGA périodique
          state.ntrip.connected = true;
          startNtripNmeaTimer();
          const leftover = Buffer.from(headerBuf.slice(sep + 4), "utf8");
          if (leftover.length) ntripSocket.emit("data", leftover);
        }
        return;
      }
      state.ntrip.connected = true;
      state.ntrip.bytes += data.length;
      if (state.serialOut.enabled && state.serialOut.forwardCorrections && serialOutPort) {
        try { serialOutPort.write(data); } catch (_) {}
      }
    });

    ntripSocket.on("error", err => { state.ntrip.error = err.message; broadcast(); });
    ntripSocket.on("close", () => {
      state.ntrip.connected = false;
      if (ntripNmeaTimer) { clearInterval(ntripNmeaTimer); ntripNmeaTimer = null; }
      broadcast();
    });
  });

  socket.on("ntripDisconnect", () => {
    if (ntripSocket) { try { ntripSocket.destroy(); } catch (_) {} }
    ntripSocket = null; state.ntrip.connected = false;
    if (ntripNmeaTimer) { clearInterval(ntripNmeaTimer); ntripNmeaTimer = null; }
    broadcast();
  });
});

setInterval(broadcast, 250);

httpServer.listen(HTTP_PORT, () => { console.log(`[HTTP] http://localhost:${HTTP_PORT}`); });