const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Inisialisasi database SQLite
const db = new sqlite3.Database("./database.sqlite");

// ==================== MEMBUAT TABEL ====================
db.serialize(() => {
  // Tabel untuk page views (total kunjungan)
  db.run(`
    CREATE TABLE IF NOT EXISTS page_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_date TEXT NOT NULL,
      hour INTEGER NOT NULL,
      count INTEGER DEFAULT 0,
      month TEXT NOT NULL,
      year TEXT NOT NULL,
      UNIQUE(visit_date, hour)
    )
  `);

  // Tabel untuk unique visitors
  db.run(`
    CREATE TABLE IF NOT EXISTS unique_visitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_id TEXT NOT NULL,
      first_visit DATE NOT NULL,
      last_visit DATE NOT NULL,
      visit_count INTEGER DEFAULT 1,
      user_agent TEXT,
      ip_address TEXT,
      UNIQUE(visitor_id)
    )
  `);

  // Tabel ringkasan harian
  db.run(`
    CREATE TABLE IF NOT EXISTS daily_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE NOT NULL,
      pageviews INTEGER DEFAULT 0,
      unique_visitors INTEGER DEFAULT 0,
      month TEXT NOT NULL,
      year TEXT NOT NULL
    )
  `);

  // Tabel ringkasan bulanan
  db.run(`
    CREATE TABLE IF NOT EXISTS monthly_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT UNIQUE NOT NULL,
      total_pageviews INTEGER DEFAULT 0,
      total_unique_visitors INTEGER DEFAULT 0,
      year TEXT NOT NULL
    )
  `);

  // Tabel ringkasan tahunan
  db.run(`
    CREATE TABLE IF NOT EXISTS yearly_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year TEXT UNIQUE NOT NULL,
      total_pageviews INTEGER DEFAULT 0,
      total_unique_visitors INTEGER DEFAULT 0
    )
  `);

  // Tabel untuk mencatat IP yang sudah direkam (anti spam per hari)
  db.run(`
    CREATE TABLE IF NOT EXISTS daily_ip_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_address TEXT NOT NULL,
      visit_date TEXT NOT NULL,
      UNIQUE(ip_address, visit_date)
    )
  `);

  console.log("✅ Database tables created successfully");
});

// ==================== FUNGSI BANTU ====================

// Mendapatkan tanggal, bulan, tahun sekarang
function getCurrentDateTime() {
  const now = new Date();
  return {
    date: now.toISOString().split("T")[0],
    hour: now.getHours(),
    month: now.toISOString().slice(0, 7),
    year: now.toISOString().slice(0, 4),
    fullDateTime: now.toISOString(),
  };
}

// Cek apakah user agent adalah bot
function isBot(userAgent) {
  if (!userAgent) return false;
  const botPatterns = [
    "bot",
    "crawler",
    "spider",
    "scraper",
    "googlebot",
    "bingbot",
    "yandexbot",
    "slurp",
    "duckduckbot",
    "baiduspider",
    "facebookexternalhit",
    "twitterbot",
    "linkedinbot",
    "whatsapp",
    "telegrambot",
    "discordbot",
    "slackbot",
    "curl",
    "wget",
    "python-requests",
    "php",
    "java",
    "perl",
    "go-http-client",
    "ruby",
    "node-fetch",
    "axios",
  ];
  const ua = userAgent.toLowerCase();
  return botPatterns.some((pattern) => ua.includes(pattern));
}

// Mendapatkan IP address dari request
function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// Update semua ringkasan (daily, monthly, yearly)
async function updateAllSummaries() {
  const { date, month, year } = getCurrentDateTime();

  // Update daily summary
  db.run(
    `
    INSERT OR REPLACE INTO daily_summary (date, pageviews, unique_visitors, month, year)
    SELECT 
      ?,
      COALESCE((SELECT SUM(count) FROM page_views WHERE visit_date = ?), 0),
      COALESCE((SELECT COUNT(DISTINCT visitor_id) FROM unique_visitors WHERE date(first_visit) = ?), 0),
      ?,
      ?
  `,
    [date, date, date, month, year]
  );

  // Update monthly summary
  db.run(
    `
    INSERT OR REPLACE INTO monthly_summary (month, total_pageviews, total_unique_visitors, year)
    SELECT 
      ?,
      COALESCE((SELECT SUM(pageviews) FROM daily_summary WHERE month = ?), 0),
      COALESCE((SELECT SUM(unique_visitors) FROM daily_summary WHERE month = ?), 0),
      ?
  `,
    [month, month, month, year]
  );

  // Update yearly summary
  db.run(
    `
    INSERT OR REPLACE INTO yearly_summary (year, total_pageviews, total_unique_visitors)
    SELECT 
      ?,
      COALESCE((SELECT SUM(total_pageviews) FROM monthly_summary WHERE year = ?), 0),
      COALESCE((SELECT SUM(total_unique_visitors) FROM monthly_summary WHERE year = ?), 0)
  `,
    [year, year, year]
  );
}

// ==================== API ENDPOINTS ====================

// 1. Mencatat kunjungan baru (LENGKAP dengan filter bot & anti spam)
app.post("/api/record-visit", (req, res) => {
  const userAgent = req.headers["user-agent"];
  const clientIp = getClientIp(req);
  const { date, hour, month, year } = getCurrentDateTime();

  // 1. CEK BOT
  if (isBot(userAgent)) {
    console.log(`🤖 Bot detected: ${userAgent}`);
    return res.json({ success: true, message: "Bot ignored", isBot: true });
  }

  // 2. CEK SPAM (Apakah IP ini sudah record hari ini?)
  db.get(
    `SELECT * FROM daily_ip_log WHERE ip_address = ? AND visit_date = ?`,
    [clientIp, date],
    (err, row) => {
      if (err) {
        return res.status(500).json({ success: false, error: err.message });
      }

      const isSpam = !!row;

      // 3. UPDATE PAGE VIEWS (tetap dihitung meskipun spam? Tidak, kita hitung hanya sekali per IP per hari)
      if (!isSpam) {
        // Catat IP untuk hari ini (anti spam)
        db.run(
          `INSERT INTO daily_ip_log (ip_address, visit_date) VALUES (?, ?)`,
          [clientIp, date]
        );

        // Update page views per jam
        db.run(
          `
        INSERT INTO page_views (visit_date, hour, count, month, year)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(visit_date, hour) DO UPDATE SET count = count + 1
      `,
          [date, hour, month, year]
        );
      }

      // 4. UNIQUE VISITOR (Dari cookie/local storage visitorId)
      let visitorId = req.headers["x-visitor-id"];

      if (visitorId) {
        // Cek apakah visitor sudah ada
        db.get(
          `SELECT * FROM unique_visitors WHERE visitor_id = ?`,
          [visitorId],
          (err, existingVisitor) => {
            if (err) {
              return res
                .status(500)
                .json({ success: false, error: err.message });
            }

            if (existingVisitor) {
              // Update existing visitor
              db.run(
                `
            UPDATE unique_visitors 
            SET last_visit = ?, visit_count = visit_count + 1, user_agent = ?, ip_address = ?
            WHERE visitor_id = ?
          `,
                [date, userAgent, clientIp, visitorId]
              );
            } else {
              // Insert new unique visitor
              db.run(
                `
            INSERT INTO unique_visitors (visitor_id, first_visit, last_visit, visit_count, user_agent, ip_address)
            VALUES (?, ?, ?, 1, ?, ?)
          `,
                [visitorId, date, date, userAgent, clientIp]
              );
            }
          }
        );
      }

      // 5. UPDATE SEMUA RINGKASAN
      updateAllSummaries();

      // 6. AMBIL STAT TERBARU
      getCurrentStats((stats) => {
        res.json({
          success: true,
          message: isSpam ? "Already recorded today" : "Visit recorded",
          isSpam: isSpam,
          isBot: false,
          data: stats,
        });
      });
    }
  );
});

// Fungsi untuk mengambil statistik terkini
function getCurrentStats(callback) {
  const { date, month, year } = getCurrentDateTime();

  db.get(
    `SELECT pageviews FROM daily_summary WHERE date = ?`,
    [date],
    (err, daily) => {
      db.get(
        `SELECT total_pageviews as pageviews FROM monthly_summary WHERE month = ?`,
        [month],
        (err, monthly) => {
          db.get(
            `SELECT total_pageviews as pageviews FROM yearly_summary WHERE year = ?`,
            [year],
            (err, yearly) => {
              db.get(
                `SELECT unique_visitors FROM daily_summary WHERE date = ?`,
                [date],
                (err, uniqueDaily) => {
                  callback({
                    daily_pageviews: daily ? daily.pageviews : 0,
                    daily_unique: uniqueDaily ? uniqueDaily.unique_visitors : 0,
                    monthly_pageviews: monthly ? monthly.pageviews : 0,
                    yearly_pageviews: yearly ? yearly.pageviews : 0,
                    date: date,
                    month: month,
                    year: year,
                  });
                }
              );
            }
          );
        }
      );
    }
  );
}

// 2. Mendapatkan statistik kunjungan
app.get("/api/visit-stats", (req, res) => {
  const { date, month, year } = getCurrentDateTime();

  // Ambil kunjungan hari ini (pageviews)
  db.get(
    `SELECT pageviews FROM daily_summary WHERE date = ?`,
    [date],
    (err, dailyPageviews) => {
      if (err)
        return res.status(500).json({ success: false, error: err.message });

      // Ambil unique visitors hari ini
      db.get(
        `SELECT unique_visitors FROM daily_summary WHERE date = ?`,
        [date],
        (err, dailyUnique) => {
          if (err)
            return res.status(500).json({ success: false, error: err.message });

          // Ambil pageviews bulan ini
          db.get(
            `SELECT total_pageviews as pageviews FROM monthly_summary WHERE month = ?`,
            [month],
            (err, monthlyPageviews) => {
              if (err)
                return res
                  .status(500)
                  .json({ success: false, error: err.message });

              // Ambil unique visitors bulan ini
              db.get(
                `SELECT total_unique_visitors as unique_visitors FROM monthly_summary WHERE month = ?`,
                [month],
                (err, monthlyUnique) => {
                  if (err)
                    return res
                      .status(500)
                      .json({ success: false, error: err.message });

                  // Ambil pageviews tahun ini
                  db.get(
                    `SELECT total_pageviews as pageviews FROM yearly_summary WHERE year = ?`,
                    [year],
                    (err, yearlyPageviews) => {
                      if (err)
                        return res
                          .status(500)
                          .json({ success: false, error: err.message });

                      // Ambil unique visitors tahun ini
                      db.get(
                        `SELECT total_unique_visitors as unique_visitors FROM yearly_summary WHERE year = ?`,
                        [year],
                        (err, yearlyUnique) => {
                          if (err)
                            return res
                              .status(500)
                              .json({ success: false, error: err.message });

                          res.json({
                            success: true,
                            data: {
                              daily: {
                                pageviews: dailyPageviews
                                  ? dailyPageviews.pageviews
                                  : 0,
                                unique_visitors: dailyUnique
                                  ? dailyUnique.unique_visitors
                                  : 0,
                              },
                              monthly: {
                                pageviews: monthlyPageviews
                                  ? monthlyPageviews.pageviews
                                  : 0,
                                unique_visitors: monthlyUnique
                                  ? monthlyUnique.unique_visitors
                                  : 0,
                              },
                              yearly: {
                                pageviews: yearlyPageviews
                                  ? yearlyPageviews.pageviews
                                  : 0,
                                unique_visitors: yearlyUnique
                                  ? yearlyUnique.unique_visitors
                                  : 0,
                              },
                              current_date: date,
                              current_month: month,
                              current_year: year,
                            },
                          });
                        }
                      );
                    }
                  );
                }
              );
            }
          );
        }
      );
    }
  );
});

// 3. Mendapatkan history (grafik)
app.get("/api/visit-history", (req, res) => {
  const { period = "daily", limit = 30 } = req.query;

  let query = "";
  let params = [parseInt(limit)];

  switch (period) {
    case "daily":
      query = `
        SELECT date, pageviews, unique_visitors 
        FROM daily_summary 
        ORDER BY date DESC 
        LIMIT ?
      `;
      break;
    case "monthly":
      query = `
        SELECT month as period, total_pageviews as pageviews, total_unique_visitors as unique_visitors 
        FROM monthly_summary 
        ORDER BY month DESC 
        LIMIT ?
      `;
      break;
    case "yearly":
      query = `
        SELECT year as period, total_pageviews as pageviews, total_unique_visitors as unique_visitors 
        FROM yearly_summary 
        ORDER BY year DESC 
        LIMIT ?
      `;
      break;
    default:
      query = `
        SELECT date, pageviews, unique_visitors 
        FROM daily_summary 
        ORDER BY date DESC 
        LIMIT ?
      `;
  }

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({ success: true, data: rows });
  });
});

// 4. Mendapatkan top visitors
app.get("/api/top-visitors", (req, res) => {
  const { limit = 10 } = req.query;

  db.all(
    `
    SELECT visitor_id, visit_count, first_visit, last_visit 
    FROM unique_visitors 
    ORDER BY visit_count DESC 
    LIMIT ?
  `,
    [parseInt(limit)],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, error: err.message });
      }
      res.json({ success: true, data: rows });
    }
  );
});

// 5. Reset data (dengan secret key)
app.delete("/api/reset-stats", (req, res) => {
  const secretKey = req.headers["x-secret-key"];
  const validKey = process.env.SECRET_KEY || "your-secret-key-here";

  if (secretKey !== validKey) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  db.serialize(() => {
    db.run(`DELETE FROM page_views`);
    db.run(`DELETE FROM unique_visitors`);
    db.run(`DELETE FROM daily_summary`);
    db.run(`DELETE FROM monthly_summary`);
    db.run(`DELETE FROM yearly_summary`);
    db.run(`DELETE FROM daily_ip_log`);

    res.json({ success: true, message: "All statistics reset successfully" });
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    name: "Visit Statistics API",
    version: "2.0.0",
    features: [
      "Real-time page views tracking",
      "Unique visitors tracking",
      "Anti-spam (1 record per IP per day)",
      "Bot filtering",
      "Hourly, daily, monthly, yearly statistics",
    ],
    endpoints: {
      "POST /api/record-visit":
        "Record a new visit (requires x-visitor-id header)",
      "GET /api/visit-stats": "Get current statistics",
      "GET /api/visit-history?period=daily&limit=30":
        "Get visit history for charts",
      "GET /api/top-visitors?limit=10": "Get top visitors by visit count",
      "DELETE /api/reset-stats": "Reset all data (requires secret key)",
    },
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
  🚀 Visit Statistics API running on http://localhost:${PORT}
  
  📊 Endpoints:
  ┌─────────────────────────────────────────────────────────┐
  │  POST  /api/record-visit    - Record new visit         │
  │  GET   /api/visit-stats     - Get current statistics   │
  │  GET   /api/visit-history   - Get history for charts   │
  │  GET   /api/top-visitors    - Get top visitors         │
  └─────────────────────────────────────────────────────────┘
  
  💡 Tips:
  - Kirim header 'x-visitor-id' dengan UUID unik dari frontend
  - Bot akan otomatis diabaikan
  - 1 IP hanya bisa record 1x per hari
  `);
});
