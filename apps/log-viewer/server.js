require("dotenv").config();
const express = require("express");
const Redis = require("ioredis");
const path = require("path");

const app = express();
const PORT = process.env.LOG_VIEWER_PORT || 4000;
const VIEWER_TOKEN = process.env.VIEWER_TOKEN || null;
const LOG_KEY = "revstack:logs:stream";

// --- Redis ---
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});
redis.on("error", (err) => console.error("[Redis]", err.message));

// --- Auth middleware ---
function auth(req, res, next) {
  if (!VIEWER_TOKEN) return next();
  const token =
    req.query.token ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token === VIEWER_TOKEN) return next();
  res.status(401).json({ error: "Unauthorized. Pass ?token=<VIEWER_TOKEN>." });
}

// --- Static ---
app.use(express.static(path.join(__dirname, "public")));

// --- API ---
app.get("/api/logs", auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const levelFilter = (req.query.level || "").toLowerCase();
    const shopFilter = (req.query.shop || "").toLowerCase();
    const routeFilter = (req.query.route || "").toLowerCase();

    const raw = await redis.lrange(LOG_KEY, 0, 999);

    let entries = raw.map((str) => {
      try { return JSON.parse(str); } catch { return null; }
    }).filter(Boolean);

    if (levelFilter && levelFilter !== "all") {
      entries = entries.filter((e) => e.level === levelFilter);
    }
    if (shopFilter) {
      entries = entries.filter((e) => (e.shop || "").toLowerCase().includes(shopFilter));
    }
    if (routeFilter) {
      entries = entries.filter((e) => (e.route || "").toLowerCase().includes(routeFilter));
    }

    res.json({ entries: entries.slice(0, limit), total: entries.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Log viewer running at http://localhost:${PORT}`);
  if (VIEWER_TOKEN) console.log("  Auth: VIEWER_TOKEN is set");
  else console.log("  Auth: none (set VIEWER_TOKEN env to enable)");
});
