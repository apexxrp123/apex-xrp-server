const fs = require("fs");
const path = require("path");

const filePath = process.env.VISIT_COUNT_PATH
  || (fs.existsSync("/data") ? "/data/visit-count.json" : path.join(__dirname, "data", "visit-count.json"));

let total = 0;

function ensureDir(p) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
}

function load() {
  try {
    ensureDir(filePath);
    if (!fs.existsSync(filePath)) { total = 0; return total; }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    total = Math.max(0, Number(parsed && parsed.total) || 0);
  } catch (_) {
    total = 0;
  }
  return total;
}

function save() {
  ensureDir(filePath);
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ ok: true, total, updatedAt: Date.now() }, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function get() {
  if (!total && fs.existsSync(filePath)) load();
  return total;
}

function hit() {
  load();
  total += 1;
  save();
  return total;
}

load();

module.exports = { filePath, load, get, hit };
