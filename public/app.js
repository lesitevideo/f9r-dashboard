// ---------- public/app.js ----------
const socket = io();
let map, marker, trackLayer;

function fixLabel(code) {
  switch (code) {
    case 4: return "RTK-FIX";
    case 5: return "RTK-FLOAT";
    case 2: return "DGPS";
    case 1: return "GPS";
    default: return "No Fix";
  }
}

function ensureMap(lat, lon) {
  if (!map) {
    map = L.map("map").setView([lat, lon], 17);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20, attribution: "© OSM" }).addTo(map);
    trackLayer = L.polyline([], { weight: 3 }).addTo(map);
    marker = L.marker([lat, lon]).addTo(map);
  }
}

function updateTelemetry(msg) {
  const s = msg.lastFix || {};
  const st = msg.stats || {};
  const sat = msg.sat || {};    
  console.log(msg);
  document.getElementById("serialInfo").textContent = `${msg.serial?.path || ""} @ ${msg.serial?.baud || ""}`;
  document.getElementById("fixType").textContent = fixLabel(s.fix);
  document.getElementById("sats").textContent = `${s.satsUsed ?? 0} / ${s.satsInView ?? 0}`;
  document.getElementById("hdop").textContent = (s.hdop ?? "").toString();
  document.getElementById("alt").textContent = (s.alt ?? "").toString();
  document.getElementById("speed").textContent = (s.speed ? s.speed.toFixed(2) : "0");
  document.getElementById("course").textContent = (s.course ? s.course.toFixed(1) : "0");
  document.getElementById("lat").textContent = (s.lat ?? "").toString();
  document.getElementById("lon").textContent = (s.lon ?? "").toString();

  document.getElementById("nmea").textContent = st.nmea ?? 0;
  document.getElementById("bad").textContent = st.bad ?? 0;
  document.getElementById("gga").textContent = st.gga ?? 0;
  document.getElementById("rmc").textContent = st.rmc ?? 0;
                                                
  // Totaux globaux
  document.getElementById("satsTracked").textContent = sat.tracked ?? 0;

  // Liste des PRN utilisés (GSA)
  const usedList = Array.isArray(sat.used) ? sat.used.join(", ") : "";
  document.getElementById("satsUsedList").textContent = usedList || "—";

  // DOP (GSA)
  const dop = sat.dop || {};
  document.getElementById("pdop").textContent = Number.isFinite(dop.pdop) ? dop.pdop : "—";
  document.getElementById("vdop").textContent = Number.isFinite(dop.vdop) ? dop.vdop : "—";
  
  // Par constellation
  const pc = sat.perConstellation || {};
  const gps  = pc.GPS     || { used: 0, inView: 0 };
  const glo  = pc.GLONASS || { used: 0, inView: 0 };
  const gal  = pc.GALILEO || { used: 0, inView: 0 };
  const bds  = pc.BEIDOU  || { used: 0, inView: 0 };

  const fmt = (o) => `${o.used ?? 0} used / ${o.inView ?? 0} in view`;
  document.getElementById("gpsCounts").textContent = fmt(gps);
  document.getElementById("gloCounts").textContent = fmt(glo);
  document.getElementById("galCounts").textContent = fmt(gal);
  document.getElementById("bdsCounts").textContent = fmt(bds);
    
    
  // Serial OUT status
  const out = msg.serialOut || {};
  const outStatus = out.enabled && out.path ? `Actif → ${out.path} @ ${out.baud}` : "Inactif";
  document.getElementById("outStatus").textContent = outStatus;

  const n = msg.ntrip || {};
  const ntripTxt = n.connected ? `Connecté à ${n.host}:${n.port}/${n.mount} — ${n.bytes} octets reçus` : (n.error ? `Erreur: ${n.error}` : "NTRIP: déconnecté");
  document.getElementById("ntripStatus").textContent = ntripTxt;

  if (s.lat && s.lon) {
    ensureMap(s.lat, s.lon);
    marker.setLatLng([s.lat, s.lon]);
    const t = msg.track || [];
    if (t.length) {
      trackLayer.setLatLngs(t.map(p => [p[0], p[1]]));
      map.panTo([s.lat, s.lon], { animate: true });
    }
  }
}

socket.on("connect", () => console.log("socket connected"));
socket.on("telemetry", updateTelemetry);
socket.on("hello", init => {
  const out = init.serialOut || {};
  document.getElementById("outPath").value = out.path || "/dev/ttyS0";
  document.getElementById("outBaud").value = out.baud || 115200;
  document.getElementById("outEnable").checked = !!out.enabled;
  document.getElementById("forwardCorr").checked = out.forwardCorrections !== false;
});

// Controls — Serial OUT
function applySerialOut() {
  const cfg = {
    path: document.getElementById("outPath").value.trim(),
    baud: parseInt(document.getElementById("outBaud").value, 10),
    enabled: document.getElementById("outEnable").checked,
    forwardCorrections: document.getElementById("forwardCorr").checked
  };
  socket.emit("configureSerialOut", cfg);
}

document.getElementById("btnApplyOut").addEventListener("click", applySerialOut);

document.getElementById("outEnable").addEventListener("change", applySerialOut);

document.getElementById("forwardCorr").addEventListener("change", applySerialOut);

// Controls — NTRIP
function connectNtrip() {
  const cfg = {
    host: document.getElementById("ntripHost").value.trim(),
    port: parseInt(document.getElementById("ntripPort").value, 10),
    mount: document.getElementById("ntripMount").value.trim(),
    user: document.getElementById("ntripUser").value,
    pass: document.getElementById("ntripPass").value
  };
  socket.emit("ntripConnect", cfg);
}

function disconnectNtrip() {
  socket.emit("ntripDisconnect");
}

document.getElementById("btnNtripConnect").addEventListener("click", connectNtrip);
document.getElementById("btnNtripDisconnect").addEventListener("click", disconnectNtrip);