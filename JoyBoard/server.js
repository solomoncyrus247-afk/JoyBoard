const express = require("express");
const http = require("http");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-this-secret";

if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL is not set. Add it in Render or your local .env.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function initDb() {
  if (!process.env.DATABASE_URL) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      email VARCHAR(160) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS messages_pair_idx
      ON messages(sender_id, receiver_id, created_at);

    CREATE INDEX IF NOT EXISTS messages_receiver_read_idx
      ON messages(receiver_id, is_read);
  `);
}

function createToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: "Please log in." });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Your session has expired. Please log in again." });
  }
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch {
    res.status(503).json({ ok: false, database: "not connected" });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (name.length < 2) return res.status(400).json({ error: "Enter your name." });
    if (!email.includes("@")) return res.status(400).json({ error: "Enter a valid email." });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

    const exists = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (exists.rowCount) return res.status(409).json({ error: "That email is already registered." });

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, avatar_url, last_seen`,
      [name, email, passwordHash]
    );

    const user = result.rows[0];
    res.status(201).json({ token: createToken(user), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create the account." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (!result.rowCount) return res.status(401).json({ error: "Email or password is incorrect." });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Email or password is incorrect." });

    await pool.query("UPDATE users SET last_seen = NOW() WHERE id = $1", [user.id]);

    res.json({
      token: createToken(user),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar_url: user.avatar_url,
        last_seen: user.last_seen
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not log in." });
  }
});

app.get("/api/me", auth, async (req, res) => {
  const result = await pool.query(
    "SELECT id, name, email, avatar_url, last_seen FROM users WHERE id = $1",
    [req.user.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "User not found." });
  res.json({ user: result.rows[0] });
});

app.get("/api/users", auth, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const result = await pool.query(
    `SELECT id, name, email, avatar_url, last_seen
     FROM users
     WHERE id <> $1 AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%')
     ORDER BY name
     LIMIT 30`,
    [req.user.id, q]
  );
  res.json({ users: result.rows });
});

app.get("/api/conversations", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT u.id, u.name, u.email, u.avatar_url, u.last_seen,
      lm.body AS last_message,
      lm.created_at AS last_message_time,
      COALESCE((
        SELECT COUNT(*) FROM messages um
        WHERE um.sender_id = u.id AND um.receiver_id = $1 AND um.is_read = FALSE
      ), 0) AS unread_count
     FROM users u
     JOIN LATERAL (
       SELECT body, created_at
       FROM messages m
       WHERE (m.sender_id = $1 AND m.receiver_id = u.id)
          OR (m.sender_id = u.id AND m.receiver_id = $1)
       ORDER BY m.created_at DESC
       LIMIT 1
     ) lm ON TRUE
     WHERE u.id <> $1
     ORDER BY lm.created_at DESC`,
    [req.user.id]
  );
  res.json({ conversations: result.rows });
});

app.get("/api/messages/:otherId", auth, async (req, res) => {
  const otherId = Number(req.params.otherId);
  if (!Number.isInteger(otherId)) return res.status(400).json({ error: "Invalid user." });

  await pool.query(
    `UPDATE messages
     SET is_read = TRUE
     WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE`,
    [otherId, req.user.id]
  );

  const result = await pool.query(
    `SELECT id, sender_id, receiver_id, body, is_read, created_at
     FROM messages
     WHERE (sender_id = $1 AND receiver_id = $2)
        OR (sender_id = $2 AND receiver_id = $1)
     ORDER BY created_at ASC
     LIMIT 500`,
    [req.user.id, otherId]
  );

  res.json({ messages: result.rows });
});

app.post("/api/messages", auth, async (req, res) => {
  try {
    const receiverId = Number(req.body.receiverId);
    const body = String(req.body.body || "").trim();

    if (!Number.isInteger(receiverId) || receiverId === req.user.id) {
      return res.status(400).json({ error: "Invalid recipient." });
    }
    if (!body || body.length > 4000) {
      return res.status(400).json({ error: "Message must be 1–4000 characters." });
    }

    const receiver = await pool.query("SELECT id FROM users WHERE id = $1", [receiverId]);
    if (!receiver.rowCount) return res.status(404).json({ error: "User not found." });

    const result = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, sender_id, receiver_id, body, is_read, created_at`,
      [req.user.id, receiverId, body]
    );

    const message = result.rows[0];
    io.to(`user:${receiverId}`).emit("message:new", message);
    io.to(`user:${req.user.id}`).emit("message:sent", message);

    res.status(201).json({ message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send message." });
  }
});

app.patch("/api/messages/:otherId/read", auth, async (req, res) => {
  const otherId = Number(req.params.otherId);
  await pool.query(
    `UPDATE messages SET is_read = TRUE
     WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE`,
    [otherId, req.user.id]
  );
  io.to(`user:${otherId}`).emit("messages:read", { by: req.user.id });
  res.json({ ok: true });
});

const onlineUsers = new Map();

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication required"));
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error("Invalid session"));
  }
});

io.on("connection", (socket) => {
  const userId = Number(socket.user.id);
  socket.join(`user:${userId}`);

  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);

  io.emit("presence", { userId, online: true });

  socket.on("typing", ({ to, typing }) => {
    const receiverId = Number(to);
    if (Number.isInteger(receiverId)) {
      io.to(`user:${receiverId}`).emit("typing", {
        from: userId,
        typing: Boolean(typing)
      });
    }
  });

  socket.on("disconnect", async () => {
    const set = onlineUsers.get(userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsers.delete(userId);
        await pool.query("UPDATE users SET last_seen = NOW() WHERE id = $1", [userId]).catch(() => {});
        io.emit("presence", { userId, online: false });
      }
    }
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`JoyBoard running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
