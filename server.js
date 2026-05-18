import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";
import nodemailer from "nodemailer";
import crypto from "crypto";

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;

const FRONTEND_URL = process.env.FRONTEND_URL || "https://shiftstudio.intotheshift.io";
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_SECRET";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false") === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "contact@intotheshift.io";
const ALERT_CRON_SECRET = process.env.ALERT_CRON_SECRET || "";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors({
  origin: [
    FRONTEND_URL,
    "https://shiftstudio.intotheshift.io",
    "https://app.intotheshift.io",
    "http://localhost:3000",
    "http://localhost:5500"
  ],
  credentials: true
}));

app.use(express.json({ limit: "12mb" }));

function formatUser(user) {
  if (!user) return null;

  const quota = Number(user.passations_quota || 0);
  const used = Number(user.passations_used || 0);

  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name || "",
    lastName: user.last_name || "",
    companyName: user.company_name || "",
    organizationLogoName: user.organization_logo_name || "",
    organizationLogoDataUrl: user.organization_logo_data_url || "",
    passationLogoName: user.passation_logo_name || "",
    passationLogoDataUrl: user.passation_logo_data_url || "",
    role: user.role || "client",
    mustChangePassword: user.must_change_password === true,
    passationsQuota: quota,
    passationsUsed: used,
    passationsRemaining: Math.max(0, quota - used),
    createdAt: user.created_at || null
  };
}

function formatOrganization(org) {
  if (!org) return null;

  const quota = Number(org.passations_quota || 0);
  const used = Number(org.passations_used || 0);

  return {
    id: org.id,
    name: org.name || "",
    type: org.type || "client",
    parentId: org.parent_id || null,
    contactName: org.contact_name || "",
    contactEmail: org.contact_email || "",
    createdBy: org.created_by || null,
    passationsPack: org.passations_pack || "",
    passationsQuota: quota,
    passationsUsed: used,
    passationsRemaining: Math.max(0, quota - used),
    createdAt: org.created_at || null
  };
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function mailerIsConfigured() {
  return Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS);
}

const transporter = mailerIsConfigured()
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
      }
    })
  : null;

async function sendTransactionalEmail({ to, subject, text, html }) {
  if (!transporter) {
    console.warn("Email non envoyé : SMTP non configuré", { to, subject });
    return { sent: false, reason: "SMTP_NOT_CONFIGURED" };
  }

  try {
    await transporter.sendMail({
      from: `Into The Shift <${SMTP_FROM}>`,
      to,
      subject,
      text,
      html
    });

    return { sent: true };
  } catch (err) {
    console.error("Erreur envoi email", err);
    return { sent: false, reason: "SEND_FAILED" };
  }
}

function buildResetToken() {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
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
      reset_password_token_hash TEXT,
      reset_password_expires_at TIMESTAMP,
      must_change_password BOOLEAN DEFAULT false,
      passations_quota INTEGER DEFAULT 0,
      passations_used INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'client';
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS reset_password_token_hash TEXT;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS reset_password_expires_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT false;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS passations_quota INTEGER DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS passations_used INTEGER DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS organization_logo_name TEXT;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS organization_logo_data_url TEXT;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS passation_logo_name TEXT;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS passation_logo_data_url TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'client',
      parent_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      contact_name TEXT,
      contact_email TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      passations_pack TEXT,
      passations_quota INTEGER DEFAULT 0,
      passations_used INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS passations_pack TEXT;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS passations_quota INTEGER DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS passations_used INTEGER DEFAULT 0;
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

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS share_url TEXT;
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS results_url TEXT;
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS published_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS current_step TEXT;
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS campaign_start_date DATE;
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS campaign_end_date DATE;
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS unpublished_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS end_alert_7_sent_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS end_alert_2_sent_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS unpublished_alert_sent_at TIMESTAMP;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      start_date DATE,
      end_date DATE,
      created_at TIMESTAMP DEFAULT NOW()
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

function requirePartnerOrAdmin(req, res, next) {
  if (!req.user || !["partner", "admin"].includes(req.user.role)) {
    return res.status(403).json({ error: "Accès réservé aux partenaires." });
  }

  next();
}


function normalizeDateValue(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function getProjectParamData(data = {}) {
  if (!data || typeof data !== "object") return {};
  return data.parametrage || data.params || data.settings || data.meta || {};
}

function extractCampaignStartDate(data = {}, body = {}) {
  const param = getProjectParamData(data);
  return normalizeDateValue(
    body.campaignStartDate || body.campaign_start_date || body.startDate || body.start_date ||
    data.campaignStartDate || data.campaign_start_date || data.startDate || data.start_date ||
    data.date_lancement || data.dateLancement || param.date_lancement || param.dateLancement || param.start_date
  );
}

function extractCampaignEndDate(data = {}, body = {}) {
  const param = getProjectParamData(data);
  return normalizeDateValue(
    body.campaignEndDate || body.campaign_end_date || body.endDate || body.end_date ||
    data.campaignEndDate || data.campaign_end_date || data.endDate || data.end_date ||
    data.date_cloture || data.dateCloture || param.date_cloture || param.dateCloture || param.end_date
  );
}

function formatDateLongFr(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
}

async function autoUnpublishExpiredProjects() {
  await pool.query(`
    UPDATE projects
    SET status = 'unpublished',
        unpublished_at = COALESCE(unpublished_at, NOW()),
        updated_at = NOW()
    WHERE status = 'published'
      AND campaign_end_date IS NOT NULL
      AND campaign_end_date < CURRENT_DATE
  `);
}

function getCampaignAlertRecipient(row) {
  if (row.partner_email) {
    return {
      to: row.partner_email,
      name:
        row.partner_company_name ||
        `${row.partner_first_name || ""} ${row.partner_last_name || ""}`.trim() ||
        "partenaire"
    };
  }

  return {
    to: row.contact_email || row.user_email || "",
    name:
      row.contact_name ||
      row.user_company_name ||
      `${row.user_first_name || ""} ${row.user_last_name || ""}`.trim() ||
      ""
  };
}

function buildCampaignAlertEmail({ type, row, daysBefore, recipientName }) {
  const title = row.title || "votre autodiagnostic";
  const endDate = formatDateLongFr(row.campaign_end_date);
  const clientName = row.organization_name || row.user_company_name || "—";
  const hello = recipientName || "";

  if (type === "unpublished") {
    return {
      subject: `Campagne dépubliée — ${title}`,
      text:
`Bonjour ${hello},

La campagne d’autodiagnostic "${title}" est maintenant terminée et a été dépubliée.

Client concerné : ${clientName}
Date de fin de campagne : ${endDate}

Le lien de passation n’est plus mis en avant. L’accès aux résultats reste disponible si l’URL résultats a été renseignée.

Pour relancer ou prolonger la campagne, contactez contact@intotheshift.io.

L’équipe Into The Shift`,
      html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.5">
  <p>Bonjour ${escapeHtml(hello)},</p>
  <p>La campagne d’autodiagnostic <strong>${escapeHtml(title)}</strong> est maintenant terminée et a été dépubliée.</p>
  <p><strong>Client concerné :</strong> ${escapeHtml(clientName)}<br>
  <strong>Date de fin de campagne :</strong> ${escapeHtml(endDate)}</p>
  <p>Le lien de passation n’est plus mis en avant. L’accès aux résultats reste disponible si l’URL résultats a été renseignée.</p>
  <p>Pour relancer ou prolonger la campagne, contactez <a href="mailto:contact@intotheshift.io">contact@intotheshift.io</a>.</p>
  <p>L’équipe Into The Shift</p>
</div>`
    };
  }

  return {
    subject: `Votre autodiagnostic se termine dans ${daysBefore} jours — ${title}`,
    text:
`Bonjour ${hello},

Votre campagne d’autodiagnostic "${title}" se termine dans ${daysBefore} jours.

Client concerné : ${clientName}
Date de fin prévue : ${endDate}

Après cette date, le lien de passation ne sera plus mis en avant. L’accès aux résultats restera disponible si l’URL résultats a été renseignée.

Pour prolonger la campagne ou modifier les dates, contactez contact@intotheshift.io.

L’équipe Into The Shift`,
    html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.5">
  <p>Bonjour ${escapeHtml(hello)},</p>
  <p>Votre campagne d’autodiagnostic <strong>${escapeHtml(title)}</strong> se termine dans <strong>${daysBefore} jours</strong>.</p>
  <p><strong>Client concerné :</strong> ${escapeHtml(clientName)}<br>
  <strong>Date de fin prévue :</strong> ${escapeHtml(endDate)}</p>
  <p>Après cette date, le lien de passation ne sera plus mis en avant. L’accès aux résultats restera disponible si l’URL résultats a été renseignée.</p>
  <p>Pour prolonger la campagne ou modifier les dates, contactez <a href="mailto:contact@intotheshift.io">contact@intotheshift.io</a>.</p>
  <p>L’équipe Into The Shift</p>
</div>`
  };
}

async function getCampaignAlertRows({ type, daysBefore }) {
  if (type === "unpublished") {
    return pool.query(`
      SELECT
        p.id,
        p.title,
        p.campaign_end_date,
        p.results_url,
        p.share_url,
        o.name AS organization_name,
        o.contact_email,
        o.contact_name,
        client.email AS user_email,
        client.first_name AS user_first_name,
        client.last_name AS user_last_name,
        client.company_name AS user_company_name,
        partner.email AS partner_email,
        partner.first_name AS partner_first_name,
        partner.last_name AS partner_last_name,
        partner.company_name AS partner_company_name
      FROM projects p
      LEFT JOIN users client ON client.id = p.user_id
      LEFT JOIN organizations o ON o.id = p.organization_id
      LEFT JOIN users partner ON partner.id = o.created_by AND partner.role = 'partner'
      WHERE p.status = 'unpublished'
        AND p.campaign_end_date IS NOT NULL
        AND p.unpublished_alert_sent_at IS NULL
      ORDER BY p.campaign_end_date ASC
    `);
  }

  const sentColumn = Number(daysBefore) === 2 ? "end_alert_2_sent_at" : "end_alert_7_sent_at";

  return pool.query(`
    SELECT
      p.id,
      p.title,
      p.campaign_end_date,
      p.results_url,
      p.share_url,
      o.name AS organization_name,
      o.contact_email,
      o.contact_name,
      client.email AS user_email,
      client.first_name AS user_first_name,
      client.last_name AS user_last_name,
      client.company_name AS user_company_name,
      partner.email AS partner_email,
      partner.first_name AS partner_first_name,
      partner.last_name AS partner_last_name,
      partner.company_name AS partner_company_name
    FROM projects p
    LEFT JOIN users client ON client.id = p.user_id
    LEFT JOIN organizations o ON o.id = p.organization_id
    LEFT JOIN users partner ON partner.id = o.created_by AND partner.role = 'partner'
    WHERE p.status = 'published'
      AND p.campaign_end_date IS NOT NULL
      AND p.${sentColumn} IS NULL
      AND p.campaign_end_date = CURRENT_DATE + ($1 || ' days')::interval
    ORDER BY p.campaign_end_date ASC
  `, [daysBefore]);
}

async function processCampaignAlerts({ type, daysBefore }) {
  const result = await getCampaignAlertRows({ type, daysBefore });
  const sent = [];
  const skipped = [];

  for (const row of result.rows) {
    const recipient = getCampaignAlertRecipient(row);

    if (!recipient.to) {
      skipped.push({ id: row.id, reason: "NO_RECIPIENT" });
      continue;
    }

    const mail = buildCampaignAlertEmail({
      type,
      row,
      daysBefore,
      recipientName: recipient.name
    });

    const mailResult = await sendTransactionalEmail({
      to: recipient.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html
    });

    if (!mailResult.sent) {
      skipped.push({ id: row.id, to: recipient.to, reason: mailResult.reason || "SEND_FAILED" });
      continue;
    }

    if (type === "unpublished") {
      await pool.query(`UPDATE projects SET unpublished_alert_sent_at = NOW() WHERE id = $1`, [row.id]);
    } else if (Number(daysBefore) === 2) {
      await pool.query(`UPDATE projects SET end_alert_2_sent_at = NOW() WHERE id = $1`, [row.id]);
    } else {
      await pool.query(`UPDATE projects SET end_alert_7_sent_at = NOW() WHERE id = $1`, [row.id]);
    }

    sent.push({ id: row.id, to: recipient.to, type, daysBefore: type === "unpublished" ? null : daysBefore });
  }

  return { sent, skipped };
}

async function runCampaignAlerts() {
  const alert7 = await processCampaignAlerts({ type: "ending", daysBefore: 7 });
  const alert2 = await processCampaignAlerts({ type: "ending", daysBefore: 2 });
  await autoUnpublishExpiredProjects();
  const unpublished = await processCampaignAlerts({ type: "unpublished" });

  return {
    alert7,
    alert2,
    unpublished,
    totalSent: alert7.sent.length + alert2.sent.length + unpublished.sent.length,
    totalSkipped: alert7.skipped.length + alert2.skipped.length + unpublished.skipped.length
  };
}

async function ensureDirectClientOrganization(userId) {
  const userResult = await pool.query(
    `SELECT id, email, first_name, last_name, company_name
     FROM users
     WHERE id = $1`,
    [userId]
  );

  const user = userResult.rows[0];
  if (!user) return null;

  const companyName = String(user.company_name || "").trim();
  if (!companyName) return null;

  const existing = await pool.query(
    `SELECT id
     FROM organizations
     WHERE type = 'client'
       AND created_by = $1
       AND LOWER(name) = LOWER($2)
     LIMIT 1`,
    [userId, companyName]
  );

  if (existing.rows[0]) return existing.rows[0].id;

  const created = await pool.query(
    `INSERT INTO organizations (name, type, contact_name, contact_email, created_by)
     VALUES ($1, 'client', $2, $3, $4)
     RETURNING id`,
    [
      companyName,
      `${user.first_name || ""} ${user.last_name || ""}`.trim(),
      user.email,
      userId
    ]
  );

  return created.rows[0].id;
}

app.get("/", (req, res) => {
  res.json({ ok: true, app: "The Shift Studio API" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, app: "The Shift Studio API" });
});

app.get("/debug-version", (req, res) => {
  res.json({
    ok: true,
    version: "project-no-duplicate-v5",
    hasAdminCompanyRoute: true,
    hasPatchMeRoute: true,
    hasEmailSentResponse: true,
    hasDeleteUserRoute: true,
    hasPasswordChangeRoute: true,
    hasMustChangePasswordFlag: true,
    hasPartnerClientsApi: true,
    hasPassationsQuota: true,
    hasProjectOrganizationAutolink: true,
    hasProjectPublicationUrls: true,
    hasCreatorFields: true,
    hasProjectCurrentStep: true,
    hasProjectCloneRoute: true,
    smtpConfigured: mailerIsConfigured(),
    smtpHost: SMTP_HOST || null,
    smtpPort: SMTP_PORT || null,
    smtpSecure: SMTP_SECURE,
    frontendUrl: FRONTEND_URL
  });
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
       RETURNING id, email, first_name, last_name, company_name, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, must_change_password, passations_quota, passations_used, created_at`,
      [email.toLowerCase(), passwordHash, firstName || "", lastName || "", companyName || ""]
    );

    const user = userResult.rows[0];

    const organizationId = await ensureDirectClientOrganization(user.id);

    const projectResult = await pool.query(
      `INSERT INTO projects (user_id, title, data, created_by, organization_id)
       VALUES ($1, $2, $3, $1, $4)
       RETURNING *`,
      [user.id, "Mon premier customizer", {}, organizationId || null]
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

app.post("/api/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email requis" });
  }

  try {
    const result = await pool.query(
      `SELECT id, email, first_name FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );

    const user = result.rows[0];

    if (user) {
      const { token, tokenHash } = buildResetToken();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const resetUrl = `${FRONTEND_URL}/reset-password.html?token=${token}`;

      await pool.query(
        `UPDATE users
         SET reset_password_token_hash = $1,
             reset_password_expires_at = $2
         WHERE id = $3`,
        [tokenHash, expiresAt, user.id]
      );

      await sendTransactionalEmail({
        to: user.email,
        subject: "Réinitialisation de votre mot de passe Shift Studio",
        text:
`Bonjour ${user.first_name || ""},

Vous avez demandé à réinitialiser votre mot de passe Shift Studio.

Cliquez sur ce lien pour choisir un nouveau mot de passe :
${resetUrl}

Ce lien est valable pendant 1 heure.

Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer cet email.

L’équipe Into The Shift`,
        html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.5">
  <p>Bonjour ${escapeHtml(user.first_name || "")},</p>
  <p>Vous avez demandé à réinitialiser votre mot de passe Shift Studio.</p>
  <p>
    <a href="${resetUrl}" style="display:inline-block;background:#0d4c72;color:#ffffff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">
      Réinitialiser mon mot de passe
    </a>
  </p>
  <p>Ce lien est valable pendant 1 heure.</p>
  <p>Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer cet email.</p>
  <p>L’équipe Into The Shift</p>
</div>`
      });
    }

    res.json({
      ok: true,
      message: "Si un compte existe avec cet email, un lien de réinitialisation a été envoyé."
    });
  } catch (err) {
    console.error("Erreur forgot-password", err);
    res.status(500).json({ error: "Erreur demande de réinitialisation" });
  }
});

app.post("/api/reset-password", async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: "Token et nouveau mot de passe requis" });
  }

  if (String(password).length < 8) {
    return res.status(400).json({ error: "Le mot de passe doit contenir au moins 8 caractères" });
  }

  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const result = await pool.query(
      `SELECT id, email
       FROM users
       WHERE reset_password_token_hash = $1
         AND reset_password_expires_at > NOW()`,
      [tokenHash]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(400).json({ error: "Lien invalide ou expiré" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await pool.query(
      `UPDATE users
       SET password_hash = $1,
           reset_password_token_hash = NULL,
           reset_password_expires_at = NULL,
           must_change_password = false
       WHERE id = $2`,
      [passwordHash, user.id]
    );

    res.json({ ok: true, message: "Mot de passe réinitialisé" });
  } catch (err) {
    console.error("Erreur reset-password", err);
    res.status(500).json({ error: "Erreur réinitialisation du mot de passe" });
  }
});

app.get("/api/me", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, email, first_name, last_name, company_name, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, must_change_password, passations_quota, passations_used, created_at
     FROM users
     WHERE id = $1`,
    [req.user.id]
  );

  res.json({ user: formatUser(result.rows[0]) });
});

app.patch("/api/me", auth, async (req, res) => {
  const {
    firstName,
    lastName,
    companyName,
    organizationLogoName,
    organizationLogoDataUrl,
    passationLogoName,
    passationLogoDataUrl
  } = req.body;

  try {
    const currentResult = await pool.query(
      `SELECT id, email, first_name, last_name, company_name,
              organization_logo_name, organization_logo_data_url,
              passation_logo_name, passation_logo_data_url,
              role, must_change_password, passations_quota, passations_used, created_at
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    const current = currentResult.rows[0];
    if (!current) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    const nextFirstName = firstName !== undefined ? firstName || "" : current.first_name || "";
    const nextLastName = lastName !== undefined ? lastName || "" : current.last_name || "";
    const nextCompanyName = companyName !== undefined ? companyName || "" : current.company_name || "";
    const nextOrganizationLogoName = organizationLogoName !== undefined && organizationLogoName !== null ? organizationLogoName : current.organization_logo_name;
    const nextOrganizationLogoDataUrl = organizationLogoDataUrl !== undefined && organizationLogoDataUrl !== null ? organizationLogoDataUrl : current.organization_logo_data_url;
    const nextPassationLogoName = passationLogoName !== undefined && passationLogoName !== null ? passationLogoName : current.passation_logo_name;
    const nextPassationLogoDataUrl = passationLogoDataUrl !== undefined && passationLogoDataUrl !== null ? passationLogoDataUrl : current.passation_logo_data_url;

    const result = await pool.query(
      `UPDATE users
       SET first_name = $1,
           last_name = $2,
           company_name = $3,
           organization_logo_name = $4,
           organization_logo_data_url = $5,
           passation_logo_name = $6,
           passation_logo_data_url = $7
       WHERE id = $8
       RETURNING id, email, first_name, last_name, company_name,
                 organization_logo_name, organization_logo_data_url,
                 passation_logo_name, passation_logo_data_url,
                 role, must_change_password, passations_quota, passations_used, created_at`,
      [
        nextFirstName,
        nextLastName,
        nextCompanyName,
        nextOrganizationLogoName,
        nextOrganizationLogoDataUrl,
        nextPassationLogoName,
        nextPassationLogoDataUrl,
        req.user.id
      ]
    );

    if (nextCompanyName) {
      await ensureDirectClientOrganization(req.user.id);
    }

    res.json({ user: formatUser(result.rows[0]) });
  } catch (err) {
    console.error("Erreur mise à jour profil", err);
    res.status(500).json({ error: "Erreur mise à jour profil" });
  }
});

app.patch("/api/me/password", auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Mot de passe actuel et nouveau mot de passe requis" });
  }

  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: "Le nouveau mot de passe doit contenir au moins 8 caractères" });
  }

  try {
    const userResult = await pool.query(
      `SELECT * FROM users WHERE id = $1`,
      [req.user.id]
    );

    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Mot de passe actuel incorrect" });

    const passwordHash = await bcrypt.hash(newPassword, 10);

    const result = await pool.query(
      `UPDATE users
       SET password_hash = $1,
           must_change_password = false,
           reset_password_token_hash = NULL,
           reset_password_expires_at = NULL
       WHERE id = $2
       RETURNING id, email, first_name, last_name, company_name, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, must_change_password, passations_quota, passations_used, created_at`,
      [passwordHash, req.user.id]
    );

    res.json({ ok: true, user: formatUser(result.rows[0]) });
  } catch (err) {
    console.error("Erreur changement mot de passe", err);
    res.status(500).json({ error: "Erreur changement mot de passe" });
  }
});

app.get("/api/projects", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT
       p.*,
       o.name AS organization_name,
       o.passations_pack AS organization_passations_pack,
       o.passations_quota AS organization_passations_quota,
       o.passations_used AS organization_passations_used
     FROM projects p
     LEFT JOIN organizations o ON o.id = p.organization_id
     WHERE p.user_id = $1
     ORDER BY p.updated_at DESC`,
    [req.user.id]
  );

  res.json({
    projects: result.rows.map((row) => {
      const data = row.data || {};
      return {
        ...row,
        organizationName: row.organization_name || "",
        organizationPassationsPack: row.organization_passations_pack || "",
        organizationPassationsQuota: Number(row.organization_passations_quota || 0),
        organizationPassationsUsed: Number(row.organization_passations_used || 0),
        organizationPassationsRemaining: Math.max(
          0,
          Number(row.organization_passations_quota || 0) -
          Number(row.organization_passations_used || 0)
        ),
        shareUrl: row.share_url || "",
        resultsUrl: row.results_url || "",
        publishedAt: row.published_at || null,
        unpublishedAt: row.unpublished_at || null,
        campaignStartDate: row.campaign_start_date || data.campaignStartDate || data.campaign_start_date || data.parametrage?.date_lancement || null,
        campaignEndDate: row.campaign_end_date || data.campaignEndDate || data.campaign_end_date || data.parametrage?.date_cloture || null,
        campaign_start_date: row.campaign_start_date || data.campaign_start_date || data.parametrage?.date_lancement || null,
        campaign_end_date: row.campaign_end_date || data.campaign_end_date || data.parametrage?.date_cloture || null,
        currentStep: row.current_step || data.step || data.current_step || data.currentStep || ""
      };
    })
  });
});

app.post("/api/projects", auth, async (req, res) => {
  const { title, data, organizationId, status, currentStep } = req.body;
  const projectId =
    req.body.projectId ||
    req.body.project_id ||
    data?.currentAdId ||
    data?.project_id ||
    data?.projectId ||
    data?.state?.currentAdId ||
    data?.state?.project_id ||
    data?.payload?.currentAdId ||
    data?.payload?.project_id ||
    null;

  const configSent =
    data?.configTransmise === true ||
    data?.config_transmise === true ||
    data?.submitted === true ||
    data?.payload?.configTransmise === true ||
    data?.payload?.config_transmise === true ||
    data?.payload?.submitted === true;

  const finalStatus = status || (configSent ? "sent" : "draft");
  const finalStep = currentStep || data?.step || data?.current_step || data?.currentStep || null;
  const finalCampaignStartDate = extractCampaignStartDate(data || {}, req.body || {});
  const finalCampaignEndDate = extractCampaignEndDate(data || {}, req.body || {});

  let finalOrganizationId = organizationId || null;

  if (!finalOrganizationId) {
    finalOrganizationId = await ensureDirectClientOrganization(req.user.id);
  }

  if (projectId) {
    const updateResult = await pool.query(
      `UPDATE projects
       SET title = COALESCE($1, title),
           status = COALESCE($2, status),
           data = COALESCE($3, data),
           organization_id = COALESCE($4, organization_id),
           current_step = COALESCE($5, current_step),
           campaign_start_date = COALESCE($6, campaign_start_date),
           campaign_end_date = COALESCE($7, campaign_end_date),
           updated_at = NOW()
       WHERE id = $8 AND user_id = $9
       RETURNING *`,
      [
        title || null,
        finalStatus,
        data || null,
        finalOrganizationId || null,
        finalStep,
        finalCampaignStartDate,
        finalCampaignEndDate,
        projectId,
        req.user.id
      ]
    );

    if (updateResult.rows[0]) {
      return res.json({ project: updateResult.rows[0] });
    }
  }

  const result = await pool.query(
    `INSERT INTO projects (user_id, title, status, data, created_by, organization_id, current_step, campaign_start_date, campaign_end_date)
     VALUES ($1, $2, $3, $4, $1, $5, $6, $7, $8)
     RETURNING *`,
    [
      req.user.id,
      title || "Nouveau projet",
      finalStatus,
      data || {},
      finalOrganizationId || null,
      finalStep,
      finalCampaignStartDate,
      finalCampaignEndDate
    ]
  );

  res.json({ project: result.rows[0] });
});

app.get("/api/projects/:id", auth, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT
         p.*,
         o.name AS organization_name,
         o.passations_pack AS organization_passations_pack,
         o.passations_quota AS organization_passations_quota,
         o.passations_used AS organization_passations_used
       FROM projects p
       LEFT JOIN organizations o ON o.id = p.organization_id
       WHERE p.id = $1 AND p.user_id = $2
       LIMIT 1`,
      [id, req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const row = result.rows[0];
    const data = row.data || {};

    res.json({
      project: {
        ...row,
        organizationName: row.organization_name || "",
        organizationPassationsPack: row.organization_passations_pack || "",
        organizationPassationsQuota: Number(row.organization_passations_quota || 0),
        organizationPassationsUsed: Number(row.organization_passations_used || 0),
        organizationPassationsRemaining: Math.max(
          0,
          Number(row.organization_passations_quota || 0) -
          Number(row.organization_passations_used || 0)
        ),
        shareUrl: row.share_url || "",
        resultsUrl: row.results_url || "",
        publishedAt: row.published_at || null,
        unpublishedAt: row.unpublished_at || null,
        campaignStartDate: row.campaign_start_date || data.campaignStartDate || data.campaign_start_date || data.parametrage?.date_lancement || null,
        campaignEndDate: row.campaign_end_date || data.campaignEndDate || data.campaign_end_date || data.parametrage?.date_cloture || null,
        campaign_start_date: row.campaign_start_date || data.campaign_start_date || data.parametrage?.date_lancement || null,
        campaign_end_date: row.campaign_end_date || data.campaign_end_date || data.parametrage?.date_cloture || null,
        currentStep: row.current_step || data.step || data.current_step || data.currentStep || ""
      }
    });
  } catch (err) {
    console.error("GET /api/projects/:id", err);
    res.status(500).json({ error: "Erreur chargement projet" });
  }
});

app.post("/api/projects/:id/clone", auth, async (req, res) => {
  const { id } = req.params;

  try {
    const sourceResult = await pool.query(
      `SELECT *
       FROM projects
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [id, req.user.id]
    );

    const source = sourceResult.rows[0];

    if (!source) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    if (!["sent", "published", "unpublished", "results"].includes(String(source.status || "").toLowerCase())) {
      return res.status(400).json({ error: "Le clonage est disponible après transmission ou publication." });
    }

    const clonedData = { ...(source.data || {}) };
    clonedData.clonedFromProjectId = source.id;
    clonedData.configTransmise = false;
    clonedData.config_transmise = false;
    clonedData.submitted = false;
    clonedData.submitted_at = null;
    clonedData.step = "questions";
    clonedData.current_step = "questions";

    const clonedTitle = `Copie de ${source.title || "Autodiagnostic"}`;

    const result = await pool.query(
      `INSERT INTO projects (user_id, title, status, data, created_by, organization_id, current_step)
       VALUES ($1, $2, 'draft', $3, $1, $4, 'questions')
       RETURNING *`,
      [
        req.user.id,
        clonedTitle,
        clonedData,
        source.organization_id || null
      ]
    );

    res.status(201).json({ project: result.rows[0] });
  } catch (err) {
    console.error("POST /api/projects/:id/clone", err);
    res.status(500).json({ error: "Erreur clonage projet" });
  }
});

app.put("/api/projects/:id", auth, async (req, res) => {
  const { id } = req.params;

  const {
    title,
    data,
    organizationId,
    status,
    currentStep
  } = req.body;

  let finalStatus = status || null;
  let finalOrganizationId = organizationId || null;
  const finalStep = currentStep || data?.step || data?.current_step || data?.currentStep || null;
  const finalCampaignStartDate = extractCampaignStartDate(data || {}, req.body || {});
  const finalCampaignEndDate = extractCampaignEndDate(data || {}, req.body || {});

  const configSent =
    data?.configTransmise === true ||
    data?.config_transmise === true ||
    data?.submitted === true;

  if (!finalStatus) {
    finalStatus = configSent ? "sent" : "draft";
  }

  if (!finalOrganizationId) {
    finalOrganizationId = await ensureDirectClientOrganization(req.user.id);
  }

  const result = await pool.query(
    `UPDATE projects
     SET title = COALESCE($1, title),
         data = COALESCE($2, data),
         organization_id = COALESCE($3, organization_id),
         status = COALESCE($4, status),
         current_step = COALESCE($5, current_step),
         campaign_start_date = COALESCE($6, campaign_start_date),
         campaign_end_date = COALESCE($7, campaign_end_date),
         updated_at = NOW()
     WHERE id = $8 AND user_id = $9
     RETURNING *`,
    [
      title || null,
      data || null,
      finalOrganizationId || null,
      finalStatus,
      finalStep,
      finalCampaignStartDate,
      finalCampaignEndDate,
      id,
      req.user.id
    ]
  );

  if (!result.rows[0]) {
    return res.status(404).json({ error: "Projet introuvable" });
  }

  res.json({ project: result.rows[0] });
});

app.get("/api/partner/me", auth, requirePartnerOrAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, company_name, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, must_change_password, passations_quota, passations_used, created_at
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    res.json({ partner: formatUser(result.rows[0]) });
  } catch (err) {
    console.error("GET /api/partner/me", err);
    res.status(500).json({ error: "Erreur chargement quota partenaire." });
  }
});

app.get("/api/partner/clients", auth, requirePartnerOrAdmin, async (req, res) => {
  try {
    const params = [];
    let whereClause = "o.type = 'client'";

    if (req.user.role !== "admin") {
      params.push(req.user.id);
      whereClause += " AND o.created_by = $1";
    }

    const result = await pool.query(`
      SELECT
        o.id,
        o.name,
        o.contact_name,
        o.contact_email,
        o.created_at,
        o.passations_pack,
        o.passations_quota,
        o.passations_used,
        COUNT(DISTINCT p.id)::int AS ads_count,
        COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'active')::int AS active_campaigns_count,
        COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'draft')::int AS drafts_count,
        COALESCE(
          json_agg(
            DISTINCT jsonb_build_object(
              'id', p.id,
              'title', p.title,
              'status', p.status,
              'updated_at', p.updated_at,
              'share_url', p.share_url,
              'results_url', p.results_url,
              'published_at', p.published_at
            )
          ) FILTER (WHERE p.id IS NOT NULL),
          '[]'
        ) AS projects
      FROM organizations o
      LEFT JOIN projects p ON p.organization_id = o.id
      LEFT JOIN campaigns c ON c.organization_id = o.id
      WHERE ${whereClause}
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `, params);

    res.json({ clients: result.rows });
  } catch (err) {
    console.error("GET /api/partner/clients", err);
    res.status(500).json({ error: "Erreur chargement clients partenaires." });
  }
});

app.post("/api/partner/clients", auth, requirePartnerOrAdmin, async (req, res) => {
  try {
    const { name, contactName, contactEmail } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Le nom du client est obligatoire." });
    }

    const result = await pool.query(`
      INSERT INTO organizations (name, type, contact_name, contact_email, created_by)
      VALUES ($1, 'client', $2, $3, $4)
      RETURNING *
    `, [
      name,
      contactName || null,
      contactEmail || null,
      req.user.id
    ]);

    res.status(201).json({ client: formatOrganization(result.rows[0]) });
  } catch (err) {
    console.error("POST /api/partner/clients", err);
    res.status(500).json({ error: "Erreur création client partenaire." });
  }
});

app.get("/api/admin/summary", auth, requireAdmin, async (req, res) => {
  await autoUnpublishExpiredProjects();
  const [users, clients, partners, projects, submitted, orgs, draftProjects, publishedProjects, resultsProjects, waitingPublication, withoutResults] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS count FROM users`),
    pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE COALESCE(role, 'client') = 'client'`),
    pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE COALESCE(role, '') = 'partner'`),
    pool.query(`SELECT COUNT(*)::int AS count FROM projects`),
    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM projects
      WHERE status ILIKE '%transmis%'
         OR status ILIKE '%submitted%'
         OR status = 'sent'
         OR status = 'published'
         OR status = 'results'
         OR COALESCE((data->>'configTransmise')::boolean, false) = true
    `),
    pool.query(`SELECT COUNT(*)::int AS count FROM organizations WHERE type = 'client'`),
    pool.query(`SELECT COUNT(*)::int AS count FROM projects WHERE COALESCE(status, 'draft') = 'draft'`),
    pool.query(`SELECT COUNT(*)::int AS count FROM projects WHERE status = 'published'`),
    pool.query(`SELECT COUNT(*)::int AS count FROM projects WHERE status = 'results' OR COALESCE(results_url, '') <> ''`),
    pool.query(`SELECT COUNT(*)::int AS count FROM projects WHERE status = 'sent'`),
    pool.query(`SELECT COUNT(*)::int AS count FROM projects WHERE status = 'published' AND COALESCE(results_url, '') = ''`)
  ]);

  res.json({
    usersCount: users.rows[0]?.count || 0,
    clientsCount: clients.rows[0]?.count || 0,
    partnersCount: partners.rows[0]?.count || 0,
    organizationsCount: orgs.rows[0]?.count || 0,
    projectsCount: projects.rows[0]?.count || 0,
    sentConfigs: submitted.rows[0]?.count || 0,
    draftProjects: draftProjects.rows[0]?.count || 0,
    publishedProjects: publishedProjects.rows[0]?.count || 0,
    resultsProjects: resultsProjects.rows[0]?.count || 0,
    waitingPublication: waitingPublication.rows[0]?.count || 0,
    publishedWithoutResults: withoutResults.rows[0]?.count || 0
  });
});

app.get("/api/admin/clients", auth, requireAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT
      u.id,
      u.email,
      u.first_name,
      u.last_name,
      u.company_name,
      u.role,
      u.must_change_password,
      u.passations_quota,
      u.passations_used,
      u.created_at,
      COUNT(p.id)::int AS projects_count,
      MAX(p.updated_at) AS last_project_update
    FROM users u
    LEFT JOIN projects p ON p.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `);

  res.json({
    clients: result.rows.map((row) => {
      const quota = Number(row.passations_quota || 0);
      const used = Number(row.passations_used || 0);

      return {
        id: row.id,
        email: row.email,
        firstName: row.first_name || "",
        lastName: row.last_name || "",
        companyName: row.company_name || "",
        role: row.role || "client",
        mustChangePassword: row.must_change_password === true,
        passationsQuota: quota,
        passationsUsed: used,
        passationsRemaining: Math.max(0, quota - used),
        createdAt: row.created_at,
        projectsCount: row.projects_count,
        lastProjectUpdate: row.last_project_update,
        status: "actif"
      };
    })
  });
});

app.get("/api/admin/organizations", auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        o.*,
        u.email AS owner_email,
        u.first_name AS owner_first_name,
        u.last_name AS owner_last_name,
        u.company_name AS owner_company_name,
        COUNT(DISTINCT p.id)::int AS projects_count
      FROM organizations o
      LEFT JOIN users u ON u.id = o.created_by
      LEFT JOIN projects p ON p.organization_id = o.id
      WHERE o.type = 'client'
      GROUP BY o.id, u.id
      ORDER BY o.created_at DESC
    `);

    res.json({
      organizations: result.rows.map((row) => ({
        ...formatOrganization(row),
        ownerEmail: row.owner_email || "",
        ownerName:
          `${row.owner_first_name || ""} ${row.owner_last_name || ""}`.trim() ||
          row.owner_company_name ||
          row.owner_email ||
          "—",
        projectsCount: Number(row.projects_count || 0)
      }))
    });
  } catch (err) {
    console.error("GET /api/admin/organizations", err);
    res.status(500).json({ error: "Erreur chargement clients finaux." });
  }
});

app.patch("/api/admin/users/:id/passations", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { passationsQuota, passationsUsed } = req.body;

  try {
    const result = await pool.query(
      `UPDATE users
       SET passations_quota = $1,
           passations_used = $2
       WHERE id = $3
       RETURNING id, email, first_name, last_name, company_name, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, must_change_password, passations_quota, passations_used, created_at`,
      [
        Number(passationsQuota || 0),
        Number(passationsUsed || 0),
        id
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json({ user: formatUser(result.rows[0]) });
  } catch (err) {
    console.error("Erreur mise à jour passations utilisateur", err);
    res.status(500).json({ error: "Erreur mise à jour passations" });
  }
});

app.patch("/api/admin/users/:id/company", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { companyName } = req.body;

  try {
    const result = await pool.query(
      `UPDATE users
       SET company_name = $1
       WHERE id = $2
       RETURNING id, email, first_name, last_name, company_name, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, must_change_password, passations_quota, passations_used, created_at`,
      [
        companyName || "",
        id
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json({ user: formatUser(result.rows[0]) });
  } catch (err) {
    console.error("Erreur mise à jour entreprise utilisateur", err);
    res.status(500).json({ error: "Erreur mise à jour entreprise" });
  }
});

app.patch("/api/admin/organizations/:id/passations", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { passationsPack, passationsQuota, passationsUsed } = req.body;

  try {
    const result = await pool.query(
      `UPDATE organizations
       SET passations_pack = $1,
           passations_quota = $2,
           passations_used = $3
       WHERE id = $4
       RETURNING *`,
      [
        passationsPack || null,
        Number(passationsQuota || 0),
        Number(passationsUsed || 0),
        id
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Organisation introuvable" });
    }

    res.json({ organization: formatOrganization(result.rows[0]) });
  } catch (err) {
    console.error("Erreur mise à jour passations organisation", err);
    res.status(500).json({ error: "Erreur mise à jour passations client final" });
  }
});

app.get("/api/admin/projects", auth, requireAdmin, async (req, res) => {
  await autoUnpublishExpiredProjects();
  const result = await pool.query(`
    SELECT
      p.id,
      p.title,
      p.status,
      p.data,
      p.trial_ends_at,
      p.created_at,
      p.updated_at,
      p.organization_id,
      o.name AS organization_name,
      o.passations_pack AS organization_passations_pack,
      o.passations_quota AS organization_passations_quota,
      o.passations_used AS organization_passations_used,
      u.id AS user_id,
      u.email,
      u.first_name,
      u.last_name,
      u.company_name,
      o.created_by AS organization_created_by,
      creator.id AS creator_id,
      creator.email AS creator_email,
      creator.first_name AS creator_first_name,
      creator.last_name AS creator_last_name,
      creator.company_name AS creator_company_name,
      creator.role AS creator_role,
      partner.id AS partner_id,
      partner.email AS partner_email,
      partner.first_name AS partner_first_name,
      partner.last_name AS partner_last_name,
      partner.company_name AS partner_company_name
    FROM projects p
    LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN organizations o ON o.id = p.organization_id
    LEFT JOIN users creator ON creator.id = COALESCE(p.created_by, p.user_id)
    LEFT JOIN users partner ON partner.id = o.created_by AND partner.role = 'partner'
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
          row.organization_passations_pack ||
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
        organizationId: row.organization_id,
        organizationName: row.organization_name || row.company_name || "",
        organizationPassationsPack: row.organization_passations_pack || "",
        organizationPassationsQuota: Number(row.organization_passations_quota || 0),
        organizationPassationsUsed: Number(row.organization_passations_used || 0),
        organizationPassationsRemaining: Math.max(
          0,
          Number(row.organization_passations_quota || 0) -
          Number(row.organization_passations_used || 0)
        ),
        trialEndsAt: row.trial_ends_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        clientName:
          row.organization_name ||
          row.company_name ||
          `${row.first_name || ""} ${row.last_name || ""}`.trim() ||
          row.email ||
          "—",
        clientEmail: row.email || "",
        creatorId: row.creator_id || row.user_id || null,
        creatorEmail: row.creator_email || row.email || "",
        creatorName:
          `${row.creator_first_name || ""} ${row.creator_last_name || ""}`.trim() ||
          row.creator_company_name ||
          row.creator_email ||
          "—",
        creatorCompanyName: row.creator_company_name || row.company_name || "",
        creatorRole: row.creator_role || "",
        partnerId: row.partner_id || null,
        partnerEmail: row.partner_email || "",
        partnerName:
          row.partner_company_name ||
          `${row.partner_first_name || ""} ${row.partner_last_name || ""}`.trim() ||
          row.partner_email ||
          "",
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

app.patch("/api/admin/projects/:id/status", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = ["draft", "sent", "published", "unpublished"];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: "Statut invalide" });
  }

  try {
    const result = await pool.query(
      `UPDATE projects
       SET status = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    res.json({
      ok: true,
      project: result.rows[0]
    });
  } catch (err) {
    console.error("Erreur mise à jour statut projet admin", err);
    res.status(500).json({ error: "Erreur mise à jour statut projet" });
  }
});


app.patch("/api/admin/projects/:id/publication", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  const {
    status,
    shareUrl,
    resultsUrl,
    share_url,
    results_url,
    campaignStartDate,
    campaignEndDate,
    campaign_start_date,
    campaign_end_date
  } = req.body;

  const finalStatus = status || "published";
  const finalShareUrl = shareUrl || share_url || "";
  const finalResultsUrl = resultsUrl || results_url || "";
  const finalCampaignStartDate = normalizeDateValue(campaignStartDate || campaign_start_date);
  const finalCampaignEndDate = normalizeDateValue(campaignEndDate || campaign_end_date);

  const allowedStatuses = ["draft", "sent", "published", "unpublished"];

  if (!allowedStatuses.includes(finalStatus)) {
    return res.status(400).json({ error: "Statut invalide" });
  }

  if (finalCampaignStartDate && finalCampaignEndDate && finalCampaignStartDate > finalCampaignEndDate) {
    return res.status(400).json({ error: "La date de début ne peut pas être postérieure à la date de fin." });
  }

  if (finalStatus === "published" && (!finalShareUrl || !finalResultsUrl)) {
    return res.status(400).json({ error: "URL de diffusion et URL résultats obligatoires pour publier." });
  }

  try {
    const existingResult = await pool.query(
      `SELECT share_url, results_url FROM projects WHERE id = $1 LIMIT 1`,
      [id]
    );

    if (!existingResult.rows[0]) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const existing = existingResult.rows[0];

    const nextShareUrl = finalStatus === "published"
      ? finalShareUrl
      : (finalStatus === "unpublished" ? (finalShareUrl || existing.share_url || "") : null);

    const nextResultsUrl = (finalStatus === "published" || finalStatus === "unpublished")
      ? (finalResultsUrl || existing.results_url || "")
      : null;

    const result = await pool.query(
      `
      UPDATE projects
      SET
        status = $1,
        share_url = $2,
        results_url = $3,
        campaign_start_date = COALESCE($4, campaign_start_date),
        campaign_end_date = COALESCE($5, campaign_end_date),
        unpublished_at = CASE
          WHEN $1 = 'unpublished' THEN COALESCE(unpublished_at, NOW())
          ELSE NULL
        END,
        published_at = CASE
          WHEN $1 = 'published' THEN COALESCE(published_at, NOW())
          ELSE published_at
        END,
        updated_at = NOW()
      WHERE id = $6
      RETURNING *
      `,
      [
        finalStatus,
        nextShareUrl,
        nextResultsUrl,
        finalCampaignStartDate,
        finalCampaignEndDate,
        id
      ]
    );

    res.json({ ok: true, project: result.rows[0] });
  } catch (err) {
    console.error("Erreur publication projet", err);
    res.status(500).json({ error: "Erreur publication projet" });
  }
});

app.post("/api/admin/campaign-alerts/send", auth, requireAdmin, async (req, res) => {
  try {
    const mode = String(req.body?.mode || "all").toLowerCase();
    let result;

    if (mode === "7" || mode === "j-7") {
      result = { alert7: await processCampaignAlerts({ type: "ending", daysBefore: 7 }) };
    } else if (mode === "2" || mode === "j-2") {
      result = { alert2: await processCampaignAlerts({ type: "ending", daysBefore: 2 }) };
    } else if (mode === "unpublished" || mode === "depublie") {
      await autoUnpublishExpiredProjects();
      result = { unpublished: await processCampaignAlerts({ type: "unpublished" }) };
    } else {
      result = await runCampaignAlerts();
    }

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Erreur alertes campagne", err);
    res.status(500).json({ error: "Erreur alertes campagne" });
  }
});

app.post("/api/campaign-alerts/run", async (req, res) => {
  const secret = req.headers["x-alert-secret"] || req.query.secret || req.body?.secret || "";

  if (!ALERT_CRON_SECRET || secret !== ALERT_CRON_SECRET) {
    return res.status(403).json({ error: "Accès refusé" });
  }

  try {
    const result = await runCampaignAlerts();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Erreur run alertes campagne", err);
    res.status(500).json({ error: "Erreur alertes campagne" });
  }
});

app.delete("/api/admin/projects/:id", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM projects
       WHERE id = $1
       RETURNING id, title`,
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    res.json({
      ok: true,
      deletedProject: result.rows[0]
    });
  } catch (err) {
    console.error("Erreur suppression projet admin", err);
    res.status(500).json({ error: "Erreur suppression projet" });
  }
});
app.post("/api/admin/test-email", auth, requireAdmin, async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email de test requis" });
  }

  const mailResult = await sendTransactionalEmail({
    to: email,
    subject: "Test email Shift Studio",
    text:
`Bonjour,

Ceci est un email de test envoyé depuis Shift Studio.

Si vous recevez ce message, la configuration SMTP fonctionne.

L’équipe Into The Shift`,
    html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.5">
  <p>Bonjour,</p>
  <p>Ceci est un email de test envoyé depuis <strong>Shift Studio</strong>.</p>
  <p>Si vous recevez ce message, la configuration SMTP fonctionne.</p>
  <p>L’équipe Into The Shift</p>
</div>`
  });

  console.log("ADMIN TEST EMAIL STATUS", {
    email,
    emailSent: mailResult.sent,
    emailStatus: mailResult.reason || "SENT"
  });

  res.json({
    ok: mailResult.sent,
    emailSent: mailResult.sent,
    emailStatus: mailResult.reason || "SENT"
  });
});

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
      `INSERT INTO users (email, password_hash, first_name, last_name, company_name, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, email, first_name, last_name, company_name, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, must_change_password, passations_quota, passations_used, created_at`,
      [
        email.toLowerCase(),
        passwordHash,
        firstName || "",
        lastName || "",
        companyName || "",
        safeRole
      ]
    );

    const user = userResult.rows[0];

    if (safeRole === "client" && companyName) {
      await ensureDirectClientOrganization(user.id);
    }

    const loginUrl = `${FRONTEND_URL}/login.html?redirect=account.html%3Ftab%3Dsecurite%26firstLogin%3D1`;

    const mailResult = await sendTransactionalEmail({
      to: user.email,
      subject: "Votre accès Shift Studio est créé",
      text:
`Bonjour ${firstName || ""},

Votre compte Shift Studio a été créé.

Vous pouvez vous connecter ici :
${loginUrl}

Identifiant : ${user.email}
Mot de passe temporaire : ${password}

Après connexion avec ce mot de passe temporaire, vous serez invité à choisir votre propre mot de passe.

L’équipe Into The Shift`,
      html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.5">
  <p>Bonjour ${escapeHtml(firstName || "")},</p>
  <p>Votre compte <strong>Shift Studio</strong> a été créé.</p>
  <p>
    <a href="${loginUrl}" style="display:inline-block;background:#0d4c72;color:#ffffff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">
      Me connecter
    </a>
  </p>
  <p><strong>Identifiant :</strong> ${escapeHtml(user.email)}</p>
  <p><strong>Mot de passe temporaire :</strong> ${escapeHtml(password)}</p>
  <p>Après connexion avec ce mot de passe temporaire, vous serez invité à choisir votre propre mot de passe.</p>
  <p>L’équipe Into The Shift</p>
</div>`
    });

    console.log("ADMIN USER CREATED EMAIL STATUS", {
      email: user.email,
      emailSent: mailResult.sent,
      emailStatus: mailResult.reason || "SENT"
    });

    res.json({
      user: formatUser(user),
      emailSent: mailResult.sent,
      emailStatus: mailResult.reason || "SENT"
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Cet email existe déjà" });
    }

    console.error("Erreur création utilisateur admin", err);
    res.status(500).json({ error: "Erreur création utilisateur" });
  }
});

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
       RETURNING id, email, first_name, last_name, company_name, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, must_change_password, passations_quota, passations_used, created_at`,
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

app.delete("/api/admin/users/:id", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  if (Number(id) === Number(req.user.id)) {
    return res.status(400).json({ error: "Vous ne pouvez pas supprimer votre propre compte admin" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userCheck = await client.query(
      `SELECT id, email, first_name, last_name, company_name, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, must_change_password, passations_quota, passations_used, created_at
       FROM users
       WHERE id = $1`,
      [id]
    );

    if (!userCheck.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    await client.query(
      `DELETE FROM projects
       WHERE organization_id IN (
         SELECT id FROM organizations WHERE created_by = $1
       )`,
      [id]
    );

    await client.query(
      `DELETE FROM organizations
       WHERE created_by = $1`,
      [id]
    );

    await client.query(
      `DELETE FROM projects
       WHERE user_id = $1 OR created_by = $1`,
      [id]
    );

    const deletedUser = await client.query(
      `DELETE FROM users
       WHERE id = $1
       RETURNING id, email, first_name, last_name, company_name, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, must_change_password, passations_quota, passations_used, created_at`,
      [id]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      deletedUser: formatUser(deletedUser.rows[0])
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erreur suppression utilisateur", err);
    res.status(500).json({ error: "Erreur suppression utilisateur" });
  } finally {
    client.release();
  }
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`);
  });

  setTimeout(() => {
    runCampaignAlerts().catch((err) => console.error("Erreur alertes campagne au démarrage", err));
  }, 30 * 1000);

  setInterval(() => {
    runCampaignAlerts().catch((err) => console.error("Erreur alertes campagne planifiées", err));
  }, 6 * 60 * 60 * 1000);
});

