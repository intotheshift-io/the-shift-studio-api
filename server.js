import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;

const FRONTEND_URL = process.env.FRONTEND_URL || "https://app.intotheshift.io";
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_SECRET";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors({
  origin: [FRONTEND_URL, "http://localhost:3000", "http://localhost:5500"],
  credentials: true
}));

app.use(express.json({ limit: "5mb" }));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      company_name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT DEFAULT 'Mon projet',
      status TEXT DEFAULT 'trial',
      data JSONB DEFAULT '{}'::jsonb,
      trial_ends_at TIMESTAMP DEFAULT NOW() + INTERVAL '14 days',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.replace("Bearer ", "");

  if (!token) return res.status(401).json({ error: "Non connecté" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Session invalide" });
  }
}

app.get("/", (req, res) => {
  res.json({ ok: true, app: "The Shift Studio API" });
});

app.post("/api/register", async (req, res) => {
  const { email, password, firstName, lastName, companyName } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email et mot de passe requis" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, company_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, first_name, last_name, company_name`,
      [email.toLowerCase(), passwordHash, firstName || "", lastName || "", companyName || ""]
    );

    const user = userResult.rows[0];

    const projectResult = await pool.query(
      `INSERT INTO projects (user_id, title, data)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [user.id, "Mon premier customizer", {}]
    );

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });

    res.json({ token, user, project: projectResult.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Cet email existe déjà" });
    }
    res.status(500).json({ error: "Erreur inscription" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  const result = await pool.query(
    `SELECT * FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );

  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: "Identifiants incorrects" });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Identifiants incorrects" });

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      companyName: user.company_name
    }
  });
});

app.get("/api/me", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, email, first_name, last_name, company_name FROM users WHERE id = $1`,
    [req.user.id]
  );

  res.json({ user: result.rows[0] });
});

app.get("/api/projects", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM projects WHERE user_id = $1 ORDER BY updated_at DESC`,
    [req.user.id]
  );

  res.json({ projects: result.rows });
});

app.post("/api/projects", auth, async (req, res) => {
  const { title, data } = req.body;

  const result = await pool.query(
    `INSERT INTO projects (user_id, title, data)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [req.user.id, title || "Nouveau projet", data || {}]
  );

  res.json({ project: result.rows[0] });
});

app.put("/api/projects/:id", auth, async (req, res) => {
  const { id } = req.params;
  const { title, data } = req.body;

  const result = await pool.query(
    `UPDATE projects
     SET title = COALESCE($1, title),
         data = COALESCE($2, data),
         updated_at = NOW()
     WHERE id = $3 AND user_id = $4
     RETURNING *`,
    [title || null, data || null, id, req.user.id]
  );

  if (!result.rows[0]) {
    return res.status(404).json({ error: "Projet introuvable" });
  }

  res.json({ project: result.rows[0] });
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`);
  });
});
