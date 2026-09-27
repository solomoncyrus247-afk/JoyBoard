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
const JWT_SECRET =
  process.env.JWT_SECRET || "dev-only-change-this-secret";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* =========================
   ONLINE USERS
========================= */

const onlineUsers = new Map();

function isUserOnline(userId) {
  const id = Number(userId);
  const sockets = onlineUsers.get(id);

  return !!(sockets && sockets.size > 0);
}

/* =========================
   DATABASE
========================= */

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

    CREATE TABLE IF NOT EXISTS friend_requests (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(sender_id, receiver_id)
    );

    CREATE TABLE IF NOT EXISTS friends (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, friend_id)
    );

    CREATE INDEX IF NOT EXISTS messages_pair_idx
      ON messages(sender_id, receiver_id, created_at);

    CREATE INDEX IF NOT EXISTS messages_receiver_read_idx
      ON messages(receiver_id, is_read);

    CREATE INDEX IF NOT EXISTS friend_requests_receiver_idx
      ON friend_requests(receiver_id, status);

    CREATE INDEX IF NOT EXISTS friends_user_idx
      ON friends(user_id);
  `);
}

/* =========================
   AUTH
========================= */

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      name: user.name,
      email: user.email
    },
    JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";

  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      error: "Please log in."
    });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    return res.status(401).json({
      error: "Your session has expired. Please log in again."
    });
  }
}

/* =========================
   HEALTH
========================= */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      database: "connected"
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      database: "not connected"
    });
  }
});

/* =========================
   REGISTER
========================= */

app.post("/api/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();

    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    if (name.length < 2) {
      return res.status(400).json({
        error: "Enter your name."
      });
    }

    if (name.length > 80) {
      return res.status(400).json({
        error: "Name is too long."
      });
    }

    if (!email.includes("@")) {
      return res.status(400).json({
        error: "Enter a valid email."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters."
      });
    }

    const exists = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );

    if (exists.rowCount) {
      return res.status(409).json({
        error: "That email is already registered."
      });
    }

    const passwordHash = await bcrypt.hash(
      password,
      12
    );

    const result = await pool.query(
      `INSERT INTO users
       (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING
         id,
         name,
         email,
         avatar_url,
         created_at,
         last_seen`,
      [
        name,
        email,
        passwordHash
      ]
    );

    const user = result.rows[0];

    res.status(201).json({
      token: createToken(user),

      user: {
        ...user,
        friends_count: 0,
        online: false
      }
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Could not create the account."
    });
  }
});

/* =========================
   LOGIN
========================= */

app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (!result.rowCount) {
      return res.status(401).json({
        error: "Email or password is incorrect."
      });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        error: "Email or password is incorrect."
      });
    }

    await pool.query(
      "UPDATE users SET last_seen = NOW() WHERE id = $1",
      [user.id]
    );

    res.json({
      token: createToken(user),

      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar_url: user.avatar_url,
        created_at: user.created_at,
        last_seen: new Date(),
        friends_count: 0,
        online: false
      }
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Could not log in."
    });
  }
});

/* =========================
   MY PROFILE
========================= */

app.get("/api/me", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id,
         u.name,
         u.email,
         u.avatar_url,
         u.created_at,
         u.last_seen,

         (
           SELECT COUNT(*)
           FROM friends f
           WHERE f.user_id = u.id
         ) AS friends_count

       FROM users u
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "User not found."
      });
    }

    const user = result.rows[0];

    res.json({
      user: {
        ...user,

        friends_count: Number(
          user.friends_count
        ),

        online: isUserOnline(user.id)
      }
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Could not load your profile."
    });
  }
});

/* =========================
   VIEW USER PROFILE
========================= */

app.get(
  "/api/users/:userId/profile",
  auth,
  async (req, res) => {
    try {
      const userId = Number(req.params.userId);

      if (!Number.isInteger(userId)) {
        return res.status(400).json({
          error: "Invalid user."
        });
      }

      const result = await pool.query(
        `SELECT
           u.id,
           u.name,
           u.email,
           u.avatar_url,
           u.created_at,
           u.last_seen,

           (
             SELECT COUNT(*)
             FROM friends f
             WHERE f.user_id = u.id
           ) AS friends_count,

           CASE
             WHEN f.id IS NOT NULL
               THEN 'friend'

             WHEN fr1.id IS NOT NULL
               AND fr1.status = 'pending'
               THEN 'request_sent'

             WHEN fr2.id IS NOT NULL
               AND fr2.status = 'pending'
               THEN 'request_received'

             ELSE 'none'
           END AS friendship_status

         FROM users u

         LEFT JOIN friends f
           ON f.user_id = $1
          AND f.friend_id = u.id

         LEFT JOIN friend_requests fr1
           ON fr1.sender_id = $1
          AND fr1.receiver_id = u.id
          AND fr1.status = 'pending'

         LEFT JOIN friend_requests fr2
           ON fr2.sender_id = u.id
          AND fr2.receiver_id = $1
          AND fr2.status = 'pending'

         WHERE u.id = $2`,
        [
          req.user.id,
          userId
        ]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          error: "User not found."
        });
      }

      const user = result.rows[0];

      const isFriend =
        user.friendship_status === "friend";

      res.json({
        user: {
          ...user,

          friends_count: Number(
            user.friends_count
          ),

          online: isUserOnline(user.id),

          can_message: isFriend
        }
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: "Could not load profile."
      });
    }
  }
);

/* =========================
   UPDATE PROFILE
========================= */

app.patch("/api/profile", auth, async (req, res) => {
  try {
    const name = String(
      req.body.name || ""
    ).trim();

    const avatarUrl = String(
      req.body.avatar_url || ""
    );

    if (name.length < 2 || name.length > 80) {
      return res.status(400).json({
        error: "Name must be 2–80 characters."
      });
    }

    if (
      avatarUrl &&
      !avatarUrl.startsWith("data:image/")
    ) {
      return res.status(400).json({
        error: "Invalid profile picture."
      });
    }

    if (avatarUrl.length > 1500000) {
      return res.status(400).json({
        error: "Profile picture is too large."
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET name = $1,
           avatar_url = $2
       WHERE id = $3
       RETURNING
         id,
         name,
         email,
         avatar_url,
         created_at,
         last_seen`,
      [
        name,
        avatarUrl,
        req.user.id
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "User not found."
      });
    }

    const user = result.rows[0];

    const countResult = await pool.query(
      `SELECT COUNT(*) AS friends_count
       FROM friends
       WHERE user_id = $1`,
      [req.user.id]
    );

    res.json({
      user: {
        ...user,

        friends_count: Number(
          countResult.rows[0].friends_count
        ),

        online: isUserOnline(user.id)
      }
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Could not update profile."
    });
  }
});

/* =========================
   SEARCH / PEOPLE
========================= */

app.get("/api/users", auth, async (req, res) => {
  try {
    const q = String(
      req.query.q || ""
    ).trim();

    const result = await pool.query(
      `SELECT
         u.id,
         u.name,
         u.email,
         u.avatar_url,
         u.created_at,
         u.last_seen,

         (
           SELECT COUNT(*)
           FROM friends fc
           WHERE fc.user_id = u.id
         ) AS friends_count,

         CASE
           WHEN f.id IS NOT NULL
             THEN 'friend'

           WHEN fr1.id IS NOT NULL
             AND fr1.status = 'pending'
             THEN 'request_sent'

           WHEN fr2.id IS NOT NULL
             AND fr2.status = 'pending'
             THEN 'request_received'

           ELSE 'none'
         END AS friendship_status

       FROM users u

       LEFT JOIN friends f
         ON f.user_id = $1
        AND f.friend_id = u.id

       LEFT JOIN friend_requests fr1
         ON fr1.sender_id = $1
        AND fr1.receiver_id = u.id
        AND fr1.status = 'pending'

       LEFT JOIN friend_requests fr2
         ON fr2.sender_id = u.id
        AND fr2.receiver_id = $1
        AND fr2.status = 'pending'

       WHERE u.id <> $1

       AND (
         $2 = ''
         OR u.name ILIKE '%' || $2 || '%'
         OR u.email ILIKE '%' || $2 || '%'
       )

       ORDER BY u.name
       LIMIT 30`,
      [
        req.user.id,
        q
      ]
    );

    const users = result.rows.map(
      (user) => ({
        ...user,

        friends_count: Number(
          user.friends_count
        ),

        online: isUserOnline(user.id)
      })
    );

    res.json({
      users
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Could not search users."
    });
  }
});

/* =========================
   SEND FRIEND REQUEST
========================= */

app.post(
  "/api/friends/request/:userId",
  auth,
  async (req, res) => {
    try {
      const receiverId = Number(
        req.params.userId
      );

      if (
        !Number.isInteger(receiverId) ||
        receiverId === req.user.id
      ) {
        return res.status(400).json({
          error: "Invalid user."
        });
      }

      const user = await pool.query(
        "SELECT id, name FROM users WHERE id = $1",
        [receiverId]
      );

      if (!user.rowCount) {
        return res.status(404).json({
          error: "User not found."
        });
      }

      const alreadyFriends =
        await pool.query(
          `SELECT id
           FROM friends
           WHERE user_id = $1
           AND friend_id = $2`,
          [
            req.user.id,
            receiverId
          ]
        );

      if (alreadyFriends.rowCount) {
        return res.status(409).json({
          error: "You are already friends."
        });
      }

      const oppositeRequest =
        await pool.query(
          `SELECT id
           FROM friend_requests
           WHERE sender_id = $1
           AND receiver_id = $2
           AND status = 'pending'`,
          [
            receiverId,
            req.user.id
          ]
        );

      if (oppositeRequest.rowCount) {
        return res.status(409).json({
          error:
            "This person already sent you a friend request."
        });
      }

      const result = await pool.query(
        `INSERT INTO friend_requests
         (sender_id, receiver_id, status, created_at)
         VALUES ($1, $2, 'pending', NOW())

         ON CONFLICT (sender_id, receiver_id)
         DO UPDATE SET
           status = 'pending',
           created_at = NOW()

         RETURNING
           id,
           sender_id,
           receiver_id,
           status,
           created_at`,
        [
          req.user.id,
          receiverId
        ]
      );

      io.to(`user:${receiverId}`).emit(
        "friend:request",
        {
          request: result.rows[0],

          from: {
            id: req.user.id,
            name: req.user.name
          }
        }
      );

      res.status(201).json({
        message: "Friend request sent.",
        request: result.rows[0]
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: "Could not send friend request."
      });
    }
  }
);

/* =========================
   GET FRIEND REQUESTS
========================= */

app.get(
  "/api/friends/requests",
  auth,
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT
           fr.id,
           fr.sender_id,
           fr.receiver_id,
           fr.status,
           fr.created_at,
           u.name,
           u.email,
           u.avatar_url,
           u.last_seen

         FROM friend_requests fr

         JOIN users u
           ON u.id = fr.sender_id

         WHERE fr.receiver_id = $1
         AND fr.status = 'pending'

         ORDER BY fr.created_at DESC`,
        [req.user.id]
      );

      const requests = result.rows.map(
        (request) => ({
          ...request,
          online: isUserOnline(
            request.sender_id
          )
        })
      );

      res.json({
        requests
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: "Could not load friend requests."
      });
    }
  }
);

/* =========================
   ACCEPT FRIEND REQUEST
========================= */

app.post(
  "/api/friends/accept/:requestId",
  auth,
  async (req, res) => {
    const requestId = Number(
      req.params.requestId
    );

    if (!Number.isInteger(requestId)) {
      return res.status(400).json({
        error: "Invalid request."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const request = await client.query(
        `SELECT *
         FROM friend_requests
         WHERE id = $1
         AND receiver_id = $2
         AND status = 'pending'
         FOR UPDATE`,
        [
          requestId,
          req.user.id
        ]
      );

      if (!request.rowCount) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: "Friend request not found."
        });
      }

      const senderId =
        request.rows[0].sender_id;

      const receiverId =
        req.user.id;

      await client.query(
        `UPDATE friend_requests
         SET status = 'accepted'
         WHERE id = $1`,
        [requestId]
      );

      await client.query(
        `INSERT INTO friends
         (user_id, friend_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [
          senderId,
          receiverId
        ]
      );

      await client.query(
        `INSERT INTO friends
         (user_id, friend_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [
          receiverId,
          senderId
        ]
      );

      await client.query("COMMIT");

      io.to(`user:${senderId}`).emit(
        "friend:accepted",
        {
          userId: receiverId
        }
      );

      io.to(`user:${receiverId}`).emit(
        "friend:accepted",
        {
          userId: senderId
        }
      );

      res.json({
        message:
          "Friend request accepted."
      });

    } catch (err) {
      await client.query("ROLLBACK");

      console.error(err);

      res.status(500).json({
        error:
          "Could not accept friend request."
      });

    } finally {
      client.release();
    }
  }
);

/* =========================
   DECLINE FRIEND REQUEST
========================= */

app.post(
  "/api/friends/decline/:requestId",
  auth,
  async (req, res) => {
    try {
      const requestId = Number(
        req.params.requestId
      );

      const result = await pool.query(
        `UPDATE friend_requests
         SET status = 'declined'
         WHERE id = $1
         AND receiver_id = $2
         AND status = 'pending'
         RETURNING *`,
        [
          requestId,
          req.user.id
        ]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          error:
            "Friend request not found."
        });
      }

      res.json({
        message:
          "Friend request declined."
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not decline friend request."
      });
    }
  }
);

/* =========================
   CANCEL FRIEND REQUEST
========================= */

app.delete(
  "/api/friends/request/:userId",
  auth,
  async (req, res) => {
    try {
      const receiverId = Number(
        req.params.userId
      );

      const result = await pool.query(
        `DELETE FROM friend_requests
         WHERE sender_id = $1
         AND receiver_id = $2
         AND status = 'pending'
         RETURNING id`,
        [
          req.user.id,
          receiverId
        ]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          error:
            "Friend request not found."
        });
      }

      res.json({
        message:
          "Friend request cancelled."
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not cancel friend request."
      });
    }
  }
);

/* =========================
   GET FRIENDS
========================= */

app.get(
  "/api/friends",
  auth,
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT
           u.id,
           u.name,
           u.email,
           u.avatar_url,
           u.created_at,
           u.last_seen,

           (
             SELECT COUNT(*)
             FROM friends fc
             WHERE fc.user_id = u.id
           ) AS friends_count

         FROM friends f

         JOIN users u
           ON u.id = f.friend_id

         WHERE f.user_id = $1

         ORDER BY u.name`,
        [req.user.id]
      );

      const friends = result.rows.map(
        (friend) => ({
          ...friend,

          friends_count: Number(
            friend.friends_count
          ),

          online: isUserOnline(
            friend.id
          )
        })
      );

      res.json({
        friends
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not load friends."
      });
    }
  }
);

/* =========================
   REMOVE FRIEND
========================= */

app.delete(
  "/api/friends/:userId",
  auth,
  async (req, res) => {
    try {
      const friendId = Number(
        req.params.userId
      );

      if (
        !Number.isInteger(friendId) ||
        friendId === req.user.id
      ) {
        return res.status(400).json({
          error: "Invalid friend."
        });
      }

      await pool.query(
        `DELETE FROM friends
         WHERE
           (user_id = $1 AND friend_id = $2)
           OR
           (user_id = $2 AND friend_id = $1)`,
        [
          req.user.id,
          friendId
        ]
      );

      res.json({
        message: "Friend removed."
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not remove friend."
      });
    }
  }
);

/* =========================
   CONVERSATIONS
========================= */

app.get(
  "/api/conversations",
  auth,
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT
           u.id,
           u.name,
           u.email,
           u.avatar_url,
           u.created_at,
           u.last_seen,

           lm.body AS last_message,
           lm.created_at AS last_message_time,

           COALESCE((
             SELECT COUNT(*)
             FROM messages um
             WHERE um.sender_id = u.id
             AND um.receiver_id = $1
             AND um.is_read = FALSE
           ), 0) AS unread_count

         FROM users u

         JOIN LATERAL (
           SELECT
             body,
             created_at

           FROM messages m

           WHERE
             (m.sender_id = $1
              AND m.receiver_id = u.id)

             OR

             (m.sender_id = u.id
              AND m.receiver_id = $1)

           ORDER BY m.created_at DESC
           LIMIT 1

         ) lm ON TRUE

         WHERE u.id <> $1

         AND EXISTS (
           SELECT 1
           FROM friends f
           WHERE f.user_id = $1
           AND f.friend_id = u.id
         )

         ORDER BY lm.created_at DESC`,
        [req.user.id]
      );

      const conversations =
        result.rows.map(
          (conversation) => ({
            ...conversation,

            unread_count: Number(
              conversation.unread_count
            ),

            online: isUserOnline(
              conversation.id
            )
          })
        );

      res.json({
        conversations
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not load conversations."
      });
    }
  }
);

/* =========================
   GET MESSAGES
========================= */

app.get(
  "/api/messages/:otherId",
  auth,
  async (req, res) => {
    try {
      const otherId = Number(
        req.params.otherId
      );

      if (!Number.isInteger(otherId)) {
        return res.status(400).json({
          error: "Invalid user."
        });
      }

      const friendship =
        await pool.query(
          `SELECT id
           FROM friends
           WHERE user_id = $1
           AND friend_id = $2`,
          [
            req.user.id,
            otherId
          ]
        );

      if (!friendship.rowCount) {
        return res.status(403).json({
          error:
            "You can only chat with friends."
        });
      }

      await pool.query(
        `UPDATE messages
         SET is_read = TRUE
         WHERE sender_id = $1
         AND receiver_id = $2
         AND is_read = FALSE`,
        [
          otherId,
          req.user.id
        ]
      );

      const result = await pool.query(
        `SELECT
           id,
           sender_id,
           receiver_id,
           body,
           is_read,
           created_at

         FROM messages

         WHERE
           (sender_id = $1
            AND receiver_id = $2)

           OR

           (sender_id = $2
            AND receiver_id = $1)

         ORDER BY created_at ASC

         LIMIT 500`,
        [
          req.user.id,
          otherId
        ]
      );

      res.json({
        messages: result.rows
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not load messages."
      });
    }
  }
);

/* =========================
   SEND MESSAGE
========================= */

app.post(
  "/api/messages",
  auth,
  async (req, res) => {
    try {
      const receiverId = Number(
        req.body.receiverId
      );

      const body = String(
        req.body.body || ""
      ).trim();

      if (
        !Number.isInteger(receiverId) ||
        receiverId === req.user.id
      ) {
        return res.status(400).json({
          error:
            "Invalid recipient."
        });
      }

      if (
        !body ||
        body.length > 4000
      ) {
        return res.status(400).json({
          error:
            "Message must be 1–4000 characters."
        });
      }

      const friendship =
        await pool.query(
          `SELECT id
           FROM friends
           WHERE user_id = $1
           AND friend_id = $2`,
          [
            req.user.id,
            receiverId
          ]
        );

      if (!friendship.rowCount) {
        return res.status(403).json({
          error:
            "You can only message your friends."
        });
      }

      const receiver =
        await pool.query(
          "SELECT id FROM users WHERE id = $1",
          [receiverId]
        );

      if (!receiver.rowCount) {
        return res.status(404).json({
          error:
            "User not found."
        });
      }

      const result = await pool.query(
        `INSERT INTO messages
         (sender_id, receiver_id, body)

         VALUES ($1, $2, $3)

         RETURNING
           id,
           sender_id,
           receiver_id,
           body,
           is_read,
           created_at`,
        [
          req.user.id,
          receiverId,
          body
        ]
      );

      const message =
        result.rows[0];

      io.to(`user:${receiverId}`).emit(
        "message:new",
        message
      );

      io.to(`user:${req.user.id}`).emit(
        "message:sent",
        message
      );

      res.status(201).json({
        message
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not send message."
      });
    }
  }
);

/* =========================
   MARK MESSAGES READ
========================= */

app.patch(
  "/api/messages/:otherId/read",
  auth,
  async (req, res) => {
    try {
      const otherId = Number(
        req.params.otherId
      );

      if (!Number.isInteger(otherId)) {
        return res.status(400).json({
          error: "Invalid user."
        });
      }

      await pool.query(
        `UPDATE messages
         SET is_read = TRUE

         WHERE sender_id = $1
         AND receiver_id = $2
         AND is_read = FALSE`,
        [
          otherId,
          req.user.id
        ]
      );

      io.to(`user:${otherId}`).emit(
        "messages:read",
        {
          by: req.user.id
        }
      );

      res.json({
        ok: true
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not mark messages as read."
      });
    }
  }
);

/* =========================
   SOCKET.IO AUTH
========================= */

io.use((socket, next) => {
  try {
    const token =
      socket.handshake.auth?.token;

    if (!token) {
      return next(
        new Error(
          "Authentication required"
        )
      );
    }

    socket.user = jwt.verify(
      token,
      JWT_SECRET
    );

    next();

  } catch (err) {
    next(
      new Error(
        "Invalid session"
      )
    );
  }
});

/* =========================
   SOCKET.IO
========================= */

io.on("connection", (socket) => {
  const userId = Number(
    socket.user.id
  );

  socket.join(
    `user:${userId}`
  );

  if (!onlineUsers.has(userId)) {
    onlineUsers.set(
      userId,
      new Set()
    );
  }

  onlineUsers
    .get(userId)
    .add(socket.id);

  io.emit("presence", {
    userId,
    online: true
  });

  socket.on(
    "typing",
    ({ to, typing }) => {
      const receiverId = Number(to);

      if (
        Number.isInteger(
          receiverId
        )
      ) {
        io.to(
          `user:${receiverId}`
        ).emit(
          "typing",
          {
            from: userId,
            typing: Boolean(
              typing
            )
          }
        );
      }
    }
  );

  socket.on(
    "disconnect",
    async () => {
      const set =
        onlineUsers.get(
          userId
        );

      if (!set) {
        return;
      }

      set.delete(
        socket.id
      );

      if (set.size === 0) {
        onlineUsers.delete(
          userId
        );

        await pool
          .query(
            `UPDATE users
             SET last_seen = NOW()
             WHERE id = $1`,
            [userId]
          )
          .catch(() => {});

        io.emit(
          "presence",
          {
            userId,
            online: false
          }
        );
      }
    }
  );
});

/* =========================
   FRONTEND
========================= */

app.get(
  "/{*splat}",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

/* =========================
   START SERVER
========================= */

initDb()
  .then(() => {
    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `JoyBoard running on port ${PORT}`
        );
      }
    );
  })
  .catch((err) => {
    console.error(
      "Database initialization failed:",
      err
    );

    process.exit(1);
  });
