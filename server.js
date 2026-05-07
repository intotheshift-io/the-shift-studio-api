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

function formatUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name || "",
    lastName: user.last_name || "",
    companyName: user.company_name || "",
    role: user.role || "client",
    createdAt: user.created_at || null
  };
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      company_name TEXT,
      role TEXT DEFAULT 'client',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'client';
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

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Accès admin refusé" });
  }

  next();
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
      `INSERT INTO users (email, password_hash, first_name, last_name, company_name, role)
       VALUES ($1, $2, $3, $4, $5, 'client')
       RETURNING id, email, first_name, last_name, company_name, role, created_at`,
      [email.toLowerCase(), passwordHash, firstName || "", lastName || "", companyName || ""]
    );

    const user = userResult.rows[0];

    const projectResult = await pool.query(
      `INSERT INTO projects (user_id, title, data)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [user.id, "Mon premier customizer", {}]
    );

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role || "client" },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token, user: formatUser(user), project: projectResult.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Cet email existe déjà" });
    }
    console.error("Erreur inscription", err);
    res.status(500).json({ error: "Erreur inscription" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email et mot de passe requis" });
  }

  const result = await pool.query(
    `SELECT * FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );

  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: "Identifiants incorrects" });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Identifiants incorrects" });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role || "client" },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({
    token,
    user: formatUser(user)
  });
});

app.get("/api/me", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, email, first_name, last_name, company_name, role, created_at
     FROM users
     WHERE id = $1`,
    [req.user.id]
  );

  res.json({ user: formatUser(result.rows[0]) });
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

// =========================
// ADMIN — résumé
// =========================

app.get("/api/admin/summary", auth, requireAdmin, async (req, res) => {
  const [users, clients, projects, submitted] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS count FROM users`),
    pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE COALESCE(role, 'client') = 'client'`),
    pool.query(`SELECT COUNT(*)::int AS count FROM projects`),
    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM projects
      WHERE status ILIKE '%transmis%'
         OR status ILIKE '%submitted%'
         OR COALESCE((data->>'configTransmise')::boolean, false) = true
    `)
  ]);

  res.json({
    usersCount: users.rows[0]?.count || 0,
    clientsCount: clients.rows[0]?.count || 0,
    projectsCount: projects.rows[0]?.count || 0,
    sentConfigs: submitted.rows[0]?.count || 0
  });
});

// =========================
// ADMIN — comptes
// =========================

app.get("/api/admin/clients", auth, requireAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT
      u.id,
      u.email,
      u.first_name,
      u.last_name,
      u.company_name,
      u.role,
      u.created_at,
      COUNT(p.id)::int AS projects_count,
      MAX(p.updated_at) AS last_project_update
    FROM users u
    LEFT JOIN projects p ON p.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `);

  res.json({
    clients: result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      firstName: row.first_name || "",
      lastName: row.last_name || "",
      companyName: row.company_name || "",
      role: row.role || "client",
      createdAt: row.created_at,
      projectsCount: row.projects_count,
      lastProjectUpdate: row.last_project_update,
      status: "actif"
    }))
  });
});

// =========================
// ADMIN — projets / autodiags
// =========================

app.get("/api/admin/projects", auth, requireAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT
      p.id,
      p.title,
      p.status,
      p.data,
      p.trial_ends_at,
      p.created_at,
      p.updated_at,
      u.id AS user_id,
      u.email,
      u.first_name,
      u.last_name,
      u.company_name
    FROM projects p
    LEFT JOIN users u ON u.id = p.user_id
    ORDER BY p.updated_at DESC
  `);

  res.json({
    projects: result.rows.map((row) => {
      const data = row.data || {};

      return {
        id: row.id,
        title:
          data.autodiagTitle ||
          data.title ||
          data.titre ||
          data.projectTitle ||
          row.title ||
          "Autodiag sans titre",
        status: row.status || data.status || "brouillon",
        pack:
          data.pack ||
          data.packChoisi ||
          data.selectedPack ||
          data.passationsPack ||
          "—",
        configTransmise:
          data.configTransmise ||
          data.config_transmise ||
          data.submitted ||
          false,
        data,
        trialEndsAt: row.trial_ends_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        clientName:
          row.company_name ||
          `${row.first_name || ""} ${row.last_name || ""}`.trim() ||
          row.email ||
          "—",
        clientEmail: row.email || "",
        client: {
          id: row.user_id,
          email: row.email,
          firstName: row.first_name || "",
          lastName: row.last_name || "",
          companyName: row.company_name || ""
        }
      };
    })
  });
});

// =========================
// ADMIN — création de comptes
// =========================

app.post("/api/admin/users", auth, requireAdmin, async (req, res) => {
  const {
    email,
    password,
    firstName,
    lastName,
    companyName,
    role
  } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email et mot de passe requis" });
  }

  const safeRole = ["client", "admin", "partner"].includes(role) ? role : "client";
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, company_name, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, first_name, last_name, company_name, role, created_at`,
      [
        email.toLowerCase(),
        passwordHash,
        firstName || "",
        lastName || "",
        companyName || "",
        safeRole
      ]
    );

    res.json({ user: formatUser(userResult.rows[0]) });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Cet email existe déjà" });
    }

    console.error("Erreur création utilisateur admin", err);
    res.status(500).json({ error: "Erreur création utilisateur" });
  }
});

// =========================
// ADMIN — changement de rôle
// =========================

app.patch("/api/admin/users/:id/role", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!["client", "admin", "partner"].includes(role)) {
    return res.status(400).json({ error: "Rôle invalide" });
  }

  try {
    const userResult = await pool.query(
      `UPDATE users
       SET role = $1
       WHERE id = $2
       RETURNING id, email, first_name, last_name, company_name, role, created_at`,
      [role, id]
    );

    if (!userResult.rows[0]) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json({ user: formatUser(userResult.rows[0]) });
  } catch (err) {
    console.error("Erreur changement de rôle", err);
    res.status(500).json({ error: "Erreur changement de rôle" });
  }
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`);
  });
});