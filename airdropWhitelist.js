const fs = require("fs");
const path = require("path");

const MAX = 5000;
const defaultPath = process.env.AIRDROP_WL_PATH
  || (fs.existsSync("/data") ? "/data/airdrop-whitelist.json" : path.join(__dirname, "data", "airdrop-whitelist.json"));

let filePath = defaultPath;
let list = [];

function ensureDir(p) {
  const dir = path.dirname(p);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
}

function load() {
  try {
    ensureDir(filePath);
    if (!fs.existsSync(filePath)) {
      list = [];
      return list;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.entries) ? parsed.entries : []);
  } catch (_) {
    list = [];
  }
  return list;
}

function save() {
  ensureDir(filePath);
  const tmp = filePath + ".tmp";
  const payload = JSON.stringify({ ok: true, updatedAt: Date.now(), count: list.length, entries: list }, null, 2);
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, filePath);
}

function getList() {
  if (!list.length && fs.existsSync(filePath)) load();
  return list;
}

function upsert(entry) {
  load();
  const existing = list.find((e) => e && e.address === entry.address);
  if (existing) return { replay: true, entry: existing };
  list.push(entry);
  if (list.length > MAX) list = list.slice(-MAX);
  save();
  return { replay: false, entry };
}

function toCsv(entries) {
  const rows = [["address", "name", "level", "rank", "exp", "at", "reason", "atIso"]];
  for (const e of entries || []) {
    const at = Number(e.at) || 0;
    rows.push([
      e.address || "",
      String(e.name || "").replace(/"/g, "'"),
      String(e.level ?? ""),
      String(e.rank || "").replace(/"/g, "'"),
      String(e.exp ?? ""),
      String(at),
      String(e.reason || "").replace(/"/g, "'"),
      at ? new Date(at).toISOString() : "",
    ]);
  }
  return rows.map((r) => r.map((c) => `"${String(c)}"`).join(",")).join("\n") + "\n";
}

load();

module.exports = {
  filePath,
  load,
  save,
  getList,
  upsert,
  toCsv,
};
