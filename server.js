
const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "soopgodsky221010><";

if (!DATABASE_URL) {
  console.error("DATABASE_URL 환경변수가 설정되지 않았습니다.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

const ALLOWED_KEYS = new Set([
  "gaksky_calendar_shared_v1",
  "skyCalendarEvents",
  "sky_notice_data",
  "skyDresses",
  "skyUpboItems",
  "skyProfileData",
  "skySoopViewers"
]);

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sky_day_data (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log("PostgreSQL 초기화 완료");
}

function validKey(req, res, next) {
  if (!ALLOWED_KEYS.has(req.params.key)) {
    return res.status(404).json({ error: "알 수 없는 데이터입니다." });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.get("x-admin-password") !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "관리자 인증에 실패했습니다." });
  }
  next();
}


// 공용 일정 API: 일정표와 프로필 주간일정표가 같은 PostgreSQL 데이터를 사용합니다.
app.get("/api/events", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value FROM sky_day_data WHERE key = $1",
      ["skyCalendarEvents"]
    );
    if (!result.rowCount) return res.json([]);
    const value = result.rows[0].value;
    res.json(Array.isArray(value) ? value : []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "일정을 불러오지 못했습니다." });
  }
});


// SOOP 시청자 연동 데이터: Chat SDK에서 받은 userId/userNickname을 저장합니다.
app.get("/api/soop/viewers", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value FROM sky_day_data WHERE key = $1",
      ["skySoopViewers"]
    );
    if (!result.rowCount) return res.json([]);
    const value = result.rows[0].value;
    res.json(Array.isArray(value) ? value : []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "SOOP 시청자 목록을 불러오지 못했습니다." });
  }
});

app.post("/api/soop/viewers", requireAdmin, async (req, res) => {
  try {
    const v = req.body || {};
    const userId = String(v.userId || "").trim();
    const userNickname = String(v.userNickname || "").trim();
    if (!userId || !userNickname) {
      return res.status(400).json({ error: "userId와 userNickname이 필요합니다." });
    }

    const current = await pool.query(
      "SELECT value FROM sky_day_data WHERE key = $1",
      ["skySoopViewers"]
    );
    let list = current.rowCount && Array.isArray(current.rows[0].value)
      ? current.rows[0].value
      : [];

    const now = new Date().toISOString();
    const next = {
      userId,
      userNickname,
      userStatus: v.userStatus || {},
      lastSeenAt: now,
      stationUrl: `https://www.sooplive.com/station/${encodeURIComponent(userId)}`
    };
    const idx = list.findIndex(x => String(x.userId) === userId);
    if (idx >= 0) list[idx] = { ...list[idx], ...next };
    else list.unshift(next);
    list = list.slice(0, 5000);

    await pool.query(
      `INSERT INTO sky_day_data (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      ["skySoopViewers", JSON.stringify(list)]
    );
    res.json({ ok: true, viewer: next });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "SOOP 시청자를 저장하지 못했습니다." });
  }
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: "database unavailable" });
  }
});

app.get("/api/data/:key", validKey, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value, updated_at FROM sky_day_data WHERE key = $1",
      [req.params.key]
    );
    if (!result.rowCount) return res.json({ exists: false });
    res.json({
      exists: true,
      value: result.rows[0].value,
      updatedAt: result.rows[0].updated_at
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "데이터를 불러오지 못했습니다." });
  }
});

app.put("/api/data/:key", validKey, requireAdmin, async (req, res) => {
  if (!Object.prototype.hasOwnProperty.call(req.body || {}, "value")) {
    return res.status(400).json({ error: "value가 필요합니다." });
  }
  try {
    await pool.query(
      `INSERT INTO sky_day_data (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [req.params.key, JSON.stringify(req.body.value)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "데이터를 저장하지 못했습니다." });
  }
});

// Express 5에서는 app.get("*") 문법이 오류를 내므로 정규식으로 처리합니다.
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => app.listen(PORT, "0.0.0.0", () => {
    console.log(`SKY-DAY server running on ${PORT}`);
  }))
  .catch((err) => {
    console.error("DB 초기화 실패", err);
    process.exit(1);
  });
