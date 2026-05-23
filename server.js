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
    jobTitle: user.job_title || "",
    sector: user.sector || "",
    organizationLogoName: user.organization_logo_name || "",
    organizationLogoDataUrl: user.organization_logo_data_url || "",
    passationLogoName: user.passation_logo_name || "",
    passationLogoDataUrl: user.passation_logo_data_url || "",
    status: user.status || "active",
    role: user.role || "client",
    mustChangePassword: user.must_change_password === true,
    passationsQuota: quota,
    passationsUsed: used,
    passationsRemaining: Math.max(0, quota - used),
    organizationId: user.organization_id || user.organizationId || null,
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

async function sendTransactionalEmail({ to, cc, bcc, subject, text, html, attachments }) {
  if (!transporter) {
    console.warn("Email non envoyé : SMTP non configuré", { to, subject });
    return { sent: false, reason: "SMTP_NOT_CONFIGURED" };
  }

  try {
    await transporter.sendMail({
      from: `Into The Shift <${SMTP_FROM}>`,
      to,
      cc,
      bcc,
      subject,
      text,
      html,
      attachments: Array.isArray(attachments) ? attachments : undefined
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
      job_title TEXT,
      sector TEXT,
      role TEXT DEFAULT 'client',
      status TEXT DEFAULT 'active',
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
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
  `);

  await pool.query(`
    UPDATE users
    SET status = 'active'
    WHERE status IS NULL OR status = '';
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
    ADD COLUMN IF NOT EXISTS job_title TEXT;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS sector TEXT;
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
    CREATE TABLE IF NOT EXISTS organization_users (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (organization_id, user_id)
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
    ADD COLUMN IF NOT EXISTS passation_logo_name TEXT;
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS passation_logo_data_url TEXT;
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS unpublished_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
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

async function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.replace("Bearer ", "");

  if (!token) return res.status(401).json({ error: "Non connecté" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);

    const statusResult = await pool.query(
      `SELECT status FROM users WHERE id = $1 LIMIT 1`,
      [req.user.id]
    );

    const status = statusResult.rows[0]?.status || "active";
    if (!statusResult.rows[0] || status !== "active") {
      return res.status(403).json({ error: "Compte désactivé ou supprimé" });
    }

    next();
  } catch (err) {
    console.error("Erreur authentification", err);
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


function isValidHttpsUrl(value) {
  const url = String(value || "").trim();
  if (!url.startsWith("https://")) return false;
  try {
    new URL(url);
    return true;
  } catch (err) {
    return false;
  }
}

function normalizeProjectStatusValue(value = "") {
  const s = String(value || "").toLowerCase();
  if (s === "archived" || s.includes("archiv")) return "archived";
  if (s === "unpublished" || s.includes("dépub") || s.includes("depub")) return "unpublished";
  if (s === "published" || s.includes("publi") || s.includes("ligne")) return "published";
  if (s === "sent" || s === "submitted" || s === "transmitted" || s.includes("transmis")) return "sent";
  return "draft";
}


function requestMarksProjectAsSent(data = {}, body = {}) {
  const d = data && typeof data === "object" ? data : {};
  const payload = d.payload && typeof d.payload === "object" ? d.payload : {};
  const state = d.state && typeof d.state === "object" ? d.state : {};
  const rawStatus = String(body.status || d.status || payload.status || state.status || "").toLowerCase();

  return (
    rawStatus === "sent" ||
    rawStatus === "submitted" ||
    rawStatus === "transmitted" ||
    rawStatus.includes("transmis") ||
    body.configTransmise === true ||
    body.config_transmise === true ||
    body.submitted === true ||
    d.configTransmise === true ||
    d.config_transmise === true ||
    d.submitted === true ||
    payload.configTransmise === true ||
    payload.config_transmise === true ||
    payload.submitted === true ||
    state.configTransmise === true ||
    state.config_transmise === true ||
    state.submitted === true ||
    d.transmission?.status === "sent" ||
    Boolean(d.transmission?.submitted_at || d.submitted_at)
  );
}

function resolveIncomingProjectStatus(status, data = {}, body = {}) {
  let normalized = normalizeProjectStatusValue(status || data?.status || body?.status || "");
  if (requestMarksProjectAsSent(data, body) && normalized === "draft") normalized = "sent";
  return normalized;
}

function getProjectNestedData(data = {}) {
  if (!data || typeof data !== "object") return {};
  const payload = data.payload && typeof data.payload === "object" ? data.payload : {};
  const state = data.state && typeof data.state === "object" ? data.state : {};
  return { payload, state };
}

function getProjectParamData(data = {}) {
  if (!data || typeof data !== "object") return {};
  const { payload, state } = getProjectNestedData(data);
  return (
    data.parametrage ||
    state.parametrage ||
    payload.parametrage ||
    data.params ||
    state.params ||
    payload.params ||
    data.settings ||
    state.settings ||
    payload.settings ||
    data.meta ||
    state.meta ||
    payload.meta ||
    {}
  );
}

function extractCampaignStartDate(data = {}, body = {}) {
  const param = getProjectParamData(data);
  const { payload, state } = getProjectNestedData(data);
  const stateParam = state.parametrage || {};
  const payloadParam = payload.parametrage || {};
  return normalizeDateValue(
    body.campaignStartDate || body.campaign_start_date || body.startDate || body.start_date ||
    data.campaignStartDate || data.campaign_start_date || data.startDate || data.start_date ||
    state.campaignStartDate || state.campaign_start_date || state.startDate || state.start_date ||
    payload.campaignStartDate || payload.campaign_start_date || payload.startDate || payload.start_date ||
    data.date_lancement || data.dateLancement ||
    state.date_lancement || state.dateLancement ||
    payload.date_lancement || payload.dateLancement ||
    param.date_lancement || param.dateLancement || param.start_date ||
    stateParam.date_lancement || stateParam.dateLancement || stateParam.start_date ||
    payloadParam.date_lancement || payloadParam.dateLancement || payloadParam.start_date
  );
}

function extractCampaignEndDate(data = {}, body = {}) {
  const param = getProjectParamData(data);
  const { payload, state } = getProjectNestedData(data);
  const stateParam = state.parametrage || {};
  const payloadParam = payload.parametrage || {};
  return normalizeDateValue(
    body.campaignEndDate || body.campaign_end_date || body.endDate || body.end_date ||
    data.campaignEndDate || data.campaign_end_date || data.endDate || data.end_date ||
    state.campaignEndDate || state.campaign_end_date || state.endDate || state.end_date ||
    payload.campaignEndDate || payload.campaign_end_date || payload.endDate || payload.end_date ||
    data.date_cloture || data.dateCloture ||
    state.date_cloture || state.dateCloture ||
    payload.date_cloture || payload.dateCloture ||
    param.date_cloture || param.dateCloture || param.end_date ||
    stateParam.date_cloture || stateParam.dateCloture || stateParam.end_date ||
    payloadParam.date_cloture || payloadParam.dateCloture || payloadParam.end_date
  );
}

function extractPassationLogoName(data = {}, body = {}) {
  const param = getProjectParamData(data);
  const campaign = data?.campagne || data?.campaign || {};
  return (
    body.passationLogoName ||
    body.passation_logo_name ||
    data.passationLogoName ||
    data.passation_logo_name ||
    param.passationLogoName ||
    param.passation_logo_name ||
    campaign.passationLogoName ||
    campaign.passation_logo_name ||
    ""
  );
}

function extractPassationLogoDataUrl(data = {}, body = {}) {
  const param = getProjectParamData(data);
  const campaign = data?.campagne || data?.campaign || {};
  return (
    body.passationLogoDataUrl ||
    body.passation_logo_data_url ||
    data.passationLogoDataUrl ||
    data.passation_logo_data_url ||
    param.passationLogoDataUrl ||
    param.passation_logo_data_url ||
    campaign.passationLogoDataUrl ||
    campaign.passation_logo_data_url ||
    ""
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
    `SELECT id, email, first_name, last_name, company_name, role
     FROM users
     WHERE id = $1`,
    [userId]
  );

  const user = userResult.rows[0];
  if (!user) return null;

  // Un partner/admin n'est pas son propre client final.
  if (String(user.role || "client").toLowerCase() !== "client") return null;

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

  // Si un cockpit client existe déjà pour ce compte mais que le nom d'entreprise
  // a varié, on réutilise ce cockpit au lieu d'en créer un nouveau sans quota.
  const existingAny = await pool.query(
    `SELECT id
     FROM organizations
     WHERE type = 'client'
       AND created_by = $1
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId]
  );

  if (existingAny.rows[0]) {
    await pool.query(
      `UPDATE organizations
       SET name = COALESCE(NULLIF($1, ''), name),
           contact_name = COALESCE(NULLIF($2, ''), contact_name),
           contact_email = COALESCE(NULLIF($3, ''), contact_email)
       WHERE id = $4`,
      [companyName, `${user.first_name || ""} ${user.last_name || ""}`.trim(), user.email, existingAny.rows[0].id]
    );
    return existingAny.rows[0].id;
  }

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

async function getUserPrimaryOrganizationId(userId) {
  const membership = await pool.query(
    `SELECT organization_id
     FROM organization_users
     WHERE user_id = $1
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId]
  );

  if (membership.rows[0]?.organization_id) {
    return membership.rows[0].organization_id;
  }

  return ensureDirectClientOrganization(userId);
}

async function addUserToOrganization({ organizationId, userId, role = "member" }) {
  const orgId = Number(organizationId);
  const uid = Number(userId);
  if (!Number.isInteger(orgId) || !Number.isInteger(uid)) return null;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Un compte client ne doit être rattaché qu'à un seul cockpit client à la fois.
    // Sans cette suppression préalable, un même user peut apparaître plusieurs fois
    // dans l'admin si plusieurs lignes organization_users existent pour lui.
    await client.query(
      `DELETE FROM organization_users
       WHERE user_id = $1
         AND organization_id <> $2`,
      [uid, orgId]
    );

    const result = await client.query(
      `INSERT INTO organization_users (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id)
       DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [orgId, uid, role || "member"]
    );

    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}


app.post("/api/staging/bootstrap-admin", async (req, res) => {
  const bootstrapSecret = process.env.STAGING_ADMIN_BOOTSTRAP_SECRET || "bootstrap-carole-2026";

  if (!bootstrapSecret) {
    return res.status(404).json({ error: "Route bootstrap désactivée" });
  }

  const providedSecret =
    req.headers["x-bootstrap-secret"] ||
    req.body?.secret ||
    req.query?.secret ||
    "";

  if (providedSecret !== bootstrapSecret) {
    return res.status(403).json({ error: "Accès refusé" });
  }

  const email = String(req.body?.email || "").trim().toLowerCase();

  if (!email) {
    return res.status(400).json({ error: "Email requis" });
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET role = 'admin'
       WHERE email = $1
       RETURNING id, email, role`,
      [email]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error("Erreur bootstrap admin staging", err);
    res.status(500).json({ error: "Erreur bootstrap admin staging" });
  }
});


app.get("/", (req, res) => {
  res.json({ ok: true, app: "The Shift Studio API" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, app: "The Shift Studio API" });
});

app.get("/debug-version", (req, res) => {
  res.json({
    ok: true,
    version: "server-archive-restore-admin-draft-v8",
    hasRobustProjectDelete: true,
    hasRobustProjectDeleteFkCleanup: true,
    hasNoRecreateDeletedProjectGuard: true,
    hasDeleteDebugMarker: true,
    hasAdminCompanyRoute: true,
    hasPatchMeRoute: true,
    hasEmailSentResponse: true,
    hasDeleteUserRoute: true,
    hasPasswordChangeRoute: true,
    hasMustChangePasswordFlag: true,
    hasPartnerClientsApi: true,
    hasPassationsQuota: true,
    hasClientOrganizationQuotaRoute: true,
    hasProjectOrganizationAutolink: true,
    hasProjectPublicationUrls: true,
    hasProjectPassationLogoFields: true,
    hasCreatorFields: true,
    hasProjectCurrentStep: true,
    hasProjectCloneRoute: true,
    hasOrganizationUsers: true,
    hasBackendTransmissionSubmit: true,
    hasUserStatusLifecycle: true,
    hasAdminUserProfileFields: true,
    smtpConfigured: mailerIsConfigured(),
    smtpHost: SMTP_HOST || null,
    smtpPort: SMTP_PORT || null,
    smtpSecure: SMTP_SECURE,
    frontendUrl: FRONTEND_URL
  });
});

app.post("/api/register", async (req, res) => {
  const { email, password, firstName, lastName, companyName, jobTitle, sector } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email et mot de passe requis" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, company_name, job_title, sector, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'client')
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
      [email.toLowerCase(), passwordHash, firstName || "", lastName || "", companyName || "", jobTitle || "", sector || ""]
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

  const userStatus = user.status || "active";
  if (userStatus !== "active") {
    return res.status(403).json({ error: "Ce compte est désactivé. Contactez Into The Shift." });
  }

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
    `SELECT id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at
     FROM users
     WHERE id = $1`,
    [req.user.id]
  );

  res.json({ user: formatUser(result.rows[0]) });
});

app.get("/api/me/organization-quota", auth, async (req, res) => {
  try {
    const organizationId = await getUserPrimaryOrganizationId(req.user.id);

    if (!organizationId) {
      return res.json({ organization: null });
    }

    const result = await pool.query(
      `SELECT *
       FROM organizations
       WHERE id = $1
       LIMIT 1`,
      [organizationId]
    );

    res.json({ organization: formatOrganization(result.rows[0]) });
  } catch (err) {
    console.error("GET /api/me/organization-quota", err);
    res.status(500).json({ error: "Erreur chargement quota client." });
  }
});

app.patch("/api/me", auth, async (req, res) => {
  const {
    firstName,
    lastName,
    companyName,
    jobTitle,
    sector,
    organizationLogoName,
    organizationLogoDataUrl,
    passationLogoName,
    passationLogoDataUrl
  } = req.body;

  try {
    const currentResult = await pool.query(
      `SELECT id, email, first_name, last_name, company_name, job_title, sector,
              organization_logo_name, organization_logo_data_url,
              passation_logo_name, passation_logo_data_url,
              role, status, must_change_password, passations_quota, passations_used, created_at
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    const current = currentResult.rows[0];
    if (!current) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    const result = await pool.query(
      `UPDATE users
       SET first_name = $1,
           last_name = $2,
           company_name = $3,
           job_title = $4,
           sector = $5,
           organization_logo_name = $6,
           organization_logo_data_url = $7,
           passation_logo_name = $8,
           passation_logo_data_url = $9
       WHERE id = $10
       RETURNING id, email, first_name, last_name, company_name, job_title, sector,
                 organization_logo_name, organization_logo_data_url,
                 passation_logo_name, passation_logo_data_url,
                 role, status, must_change_password, passations_quota, passations_used, created_at`,
      [
        firstName !== undefined ? firstName || "" : current.first_name || "",
        lastName !== undefined ? lastName || "" : current.last_name || "",
        companyName !== undefined ? companyName || "" : current.company_name || "",
        jobTitle !== undefined ? jobTitle || "" : current.job_title || "",
        sector !== undefined ? sector || "" : current.sector || "",
        organizationLogoName !== undefined && organizationLogoName !== null ? organizationLogoName : current.organization_logo_name,
        organizationLogoDataUrl !== undefined && organizationLogoDataUrl !== null ? organizationLogoDataUrl : current.organization_logo_data_url,
        passationLogoName !== undefined && passationLogoName !== null ? passationLogoName : current.passation_logo_name,
        passationLogoDataUrl !== undefined && passationLogoDataUrl !== null ? passationLogoDataUrl : current.passation_logo_data_url,
        req.user.id
      ]
    );

    if (companyName) {
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
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
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
     LEFT JOIN organization_users ou ON ou.organization_id = p.organization_id AND ou.user_id = $1
     WHERE p.user_id = $1
        OR p.created_by = $1
        OR ou.user_id IS NOT NULL
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
        archivedAt: row.archived_at || null,
        archived_at: row.archived_at || null,
        campaignStartDate: row.campaign_start_date || extractCampaignStartDate(data, {}) || null,
        campaignEndDate: row.campaign_end_date || extractCampaignEndDate(data, {}) || null,
        campaign_start_date: row.campaign_start_date || extractCampaignStartDate(data, {}) || null,
        campaign_end_date: row.campaign_end_date || extractCampaignEndDate(data, {}) || null,
        currentStep: row.current_step || data.step || data.current_step || data.currentStep || "",
        passationLogoName: row.passation_logo_name || data.passationLogoName || data.passation_logo_name || data.parametrage?.passationLogoName || data.parametrage?.passation_logo_name || "",
        passationLogoDataUrl: row.passation_logo_data_url || data.passationLogoDataUrl || data.passation_logo_data_url || data.parametrage?.passationLogoDataUrl || data.parametrage?.passation_logo_data_url || "",
        passation_logo_name: row.passation_logo_name || data.passation_logo_name || data.parametrage?.passation_logo_name || "",
        passation_logo_data_url: row.passation_logo_data_url || data.passation_logo_data_url || data.parametrage?.passation_logo_data_url || ""
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

  const finalStatus = resolveIncomingProjectStatus(status || (configSent ? "sent" : "draft"), data || {}, req.body || {});
  const finalStep = currentStep || data?.step || data?.current_step || data?.currentStep || null;
  const finalCampaignStartDate = extractCampaignStartDate(data || {}, req.body || {});
  const finalCampaignEndDate = extractCampaignEndDate(data || {}, req.body || {});
  const finalPassationLogoName = extractPassationLogoName(data || {}, req.body || {});
  const finalPassationLogoDataUrl = extractPassationLogoDataUrl(data || {}, req.body || {});

  const normalizedData = data && typeof data === "object"
    ? {
        ...data,
        campaignStartDate: finalCampaignStartDate || data.campaignStartDate || data.campaign_start_date || "",
        campaignEndDate: finalCampaignEndDate || data.campaignEndDate || data.campaign_end_date || "",
        campaign_start_date: finalCampaignStartDate || data.campaign_start_date || data.campaignStartDate || "",
        campaign_end_date: finalCampaignEndDate || data.campaign_end_date || data.campaignEndDate || "",
        passationLogoName: finalPassationLogoName || data.passationLogoName || data.passation_logo_name || "",
        passationLogoDataUrl: finalPassationLogoDataUrl || data.passationLogoDataUrl || data.passation_logo_data_url || "",
        passation_logo_name: finalPassationLogoName || data.passation_logo_name || data.passationLogoName || "",
        passation_logo_data_url: finalPassationLogoDataUrl || data.passation_logo_data_url || data.passationLogoDataUrl || ""
      }
    : data;

  let finalOrganizationId = organizationId || null;

  if (!finalOrganizationId) {
    finalOrganizationId = await getUserPrimaryOrganizationId(req.user.id);
  }

  if (projectId) {
    const currentProjectResult = await pool.query(
      `SELECT status, archived_at
       FROM projects
       WHERE id = $1
         AND (
           user_id = $2
           OR created_by = $2
           OR EXISTS (SELECT 1 FROM organization_users ou WHERE ou.organization_id = projects.organization_id AND ou.user_id = $2)
           OR EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.role = 'admin')
         )
       LIMIT 1`,
      [projectId, req.user.id]
    );

    const currentProject = currentProjectResult.rows[0];
    if (currentProject && (normalizeProjectStatusValue(currentProject.status) === "archived" || currentProject.archived_at) && finalStatus !== "archived") {
      return res.status(409).json({ error: "Projet archivé : restauration requise avant modification.", code: "PROJECT_ARCHIVED_LOCKED" });
    }

    const updateResult = await pool.query(
      `UPDATE projects
       SET title = COALESCE($1, title),
           status = COALESCE($2, status),
           data = COALESCE($3, data),
           organization_id = COALESCE($4, organization_id),
           current_step = COALESCE($5, current_step),
           campaign_start_date = COALESCE($6, campaign_start_date),
           campaign_end_date = COALESCE($7, campaign_end_date),
           passation_logo_name = COALESCE($8, passation_logo_name),
           passation_logo_data_url = COALESCE($9, passation_logo_data_url),
           updated_at = NOW()
       WHERE id = $10
         AND (
           user_id = $11
           OR created_by = $11
           OR EXISTS (SELECT 1 FROM organization_users ou WHERE ou.organization_id = projects.organization_id AND ou.user_id = $11)
         )
       RETURNING *`,
      [
        title || null,
        finalStatus,
        normalizedData || null,
        finalOrganizationId || null,
        finalStep,
        finalCampaignStartDate,
        finalCampaignEndDate,
        finalPassationLogoName || null,
        finalPassationLogoDataUrl || null,
        projectId,
        req.user.id
      ]
    );

    if (updateResult.rows[0]) {
      return res.json({ project: updateResult.rows[0] });
    }

    // Correctif important : si un projectId existe côté navigateur mais que le projet
    // n'existe plus en base, on ne doit surtout pas recréer un nouvel AD.
    // Cela évite le retour des AD supprimés depuis une ancienne sauvegarde localStorage.
    return res.status(404).json({
      error: "Projet supprimé ou introuvable",
      code: "PROJECT_NOT_FOUND_NO_RECREATE",
      projectId
    });
  }

  const result = await pool.query(
    `INSERT INTO projects (user_id, title, status, data, created_by, organization_id, current_step, campaign_start_date, campaign_end_date, passation_logo_name, passation_logo_data_url)
     VALUES ($1, $2, $3, $4, $1, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      req.user.id,
      title || "Nouveau projet",
      finalStatus,
      normalizedData || {},
      finalOrganizationId || null,
      finalStep,
      finalCampaignStartDate,
      finalCampaignEndDate,
      finalPassationLogoName || null,
      finalPassationLogoDataUrl || null
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
       WHERE p.id = $1
         AND (
           p.user_id = $2
           OR p.created_by = $2
           OR o.created_by = $2
           OR EXISTS (SELECT 1 FROM organization_users ou WHERE ou.organization_id = p.organization_id AND ou.user_id = $2)
           OR EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.role = 'admin')
         )
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
        archivedAt: row.archived_at || null,
        archived_at: row.archived_at || null,
        campaignStartDate: row.campaign_start_date || extractCampaignStartDate(data, {}) || null,
        campaignEndDate: row.campaign_end_date || extractCampaignEndDate(data, {}) || null,
        campaign_start_date: row.campaign_start_date || extractCampaignStartDate(data, {}) || null,
        campaign_end_date: row.campaign_end_date || extractCampaignEndDate(data, {}) || null,
        currentStep: row.current_step || data.step || data.current_step || data.currentStep || "",
        passationLogoName: row.passation_logo_name || data.passationLogoName || data.passation_logo_name || data.parametrage?.passationLogoName || data.parametrage?.passation_logo_name || "",
        passationLogoDataUrl: row.passation_logo_data_url || data.passationLogoDataUrl || data.passation_logo_data_url || data.parametrage?.passationLogoDataUrl || data.parametrage?.passation_logo_data_url || "",
        passation_logo_name: row.passation_logo_name || data.passation_logo_name || data.parametrage?.passation_logo_name || "",
        passation_logo_data_url: row.passation_logo_data_url || data.passation_logo_data_url || data.parametrage?.passation_logo_data_url || ""
      }
    });
  } catch (err) {
    console.error("GET /api/projects/:id", err);
    res.status(500).json({ error: "Erreur chargement projet" });
  }
});

app.delete("/api/projects/:id", auth, async (req, res) => {
  const { id } = req.params;
  const numericId = Number(id);

  if (!Number.isInteger(numericId) || numericId <= 0) {
    return res.status(400).json({ error: "ID projet invalide." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT id, title, status, data
       FROM projects
       WHERE id = $1
         AND (
           user_id = $2
           OR created_by = $2
           OR EXISTS (SELECT 1 FROM organization_users ou WHERE ou.organization_id = projects.organization_id AND ou.user_id = $2)
         )
       FOR UPDATE`,
      [numericId, req.user.id]
    );

    const project = existing.rows[0];

    if (!project) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Projet introuvable." });
    }

    const data = project.data || {};
    const rawStatus = String(project.status || data.status || "").toLowerCase();
    const isSubmitted =
      rawStatus.includes("sent") ||
      rawStatus.includes("submitted") ||
      rawStatus.includes("transmis") ||
      rawStatus.includes("publi") ||
      data.configTransmise === true ||
      data.config_transmise === true ||
      data.submitted === true ||
      Boolean(data.transmission?.submitted_at);

    if (isSubmitted) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Seuls les brouillons peuvent être supprimés." });
    }

    await client.query(`DELETE FROM campaigns WHERE project_id = $1`, [numericId]);

    const deleted = await client.query(
      `DELETE FROM projects
       WHERE id = $1
         AND (
           user_id = $2
           OR created_by = $2
           OR EXISTS (SELECT 1 FROM organization_users ou WHERE ou.organization_id = projects.organization_id AND ou.user_id = $2)
         )
       RETURNING id, title`,
      [numericId, req.user.id]
    );

    await client.query("COMMIT");

    return res.json({ ok: true, deletedProject: deleted.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("DELETE /api/projects/:id", err);
    return res.status(500).json({ error: "Erreur suppression projet." });
  } finally {
    client.release();
  }
});


app.patch("/api/projects/:id/archive", auth, async (req, res) => {
  const { id } = req.params;
  const numericId = Number(id);

  if (!Number.isInteger(numericId) || numericId <= 0) {
    return res.status(400).json({ error: "ID projet invalide." });
  }

  try {
    const result = await pool.query(
      `UPDATE projects
       SET status = 'archived',
           archived_at = COALESCE(archived_at, NOW()),
           updated_at = NOW()
       WHERE id = $1
         AND status = 'unpublished'
         AND (
           user_id = $2
           OR created_by = $2
           OR EXISTS (SELECT 1 FROM organization_users ou WHERE ou.organization_id = projects.organization_id AND ou.user_id = $2)
           OR EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.role = 'admin')
         )
       RETURNING *`,
      [numericId, req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(400).json({ error: "Un projet doit d’abord être dépublié avant d’être archivé." });
    }

    res.json({ ok: true, project: result.rows[0] });
  } catch (err) {
    console.error("PATCH /api/projects/:id/archive", err);
    res.status(500).json({ error: "Erreur archivage projet" });
  }
});

app.patch("/api/projects/:id/restore", auth, async (req, res) => {
  const { id } = req.params;
  const numericId = Number(id);

  if (!Number.isInteger(numericId) || numericId <= 0) {
    return res.status(400).json({ error: "ID projet invalide." });
  }

  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "La restauration d’une archive est réservée à l’équipe Into The Shift." });
  }

  try {
    const sourceResult = await pool.query(
      `SELECT * FROM projects WHERE id = $1 LIMIT 1`,
      [numericId]
    );

    const source = sourceResult.rows[0];
    if (!source) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const sourceData = source.data && typeof source.data === "object" ? source.data : {};
    const restoredData = {
      ...sourceData,
      restoredFromArchive: true,
      restoredFromArchiveAt: new Date().toISOString(),
      status: "draft",
      current_step: "questions",
      currentStep: "questions",
      step: "questions",
      configTransmise: false,
      config_transmise: false,
      submitted: false,
      submitted_at: null,
      shareUrl: "",
      share_url: "",
      resultsUrl: "",
      results_url: "",
      campaignStartDate: "",
      campaign_start_date: "",
      campaignEndDate: "",
      campaign_end_date: ""
    };

    if (restoredData.parametrage && typeof restoredData.parametrage === "object") {
      restoredData.parametrage.date_lancement = "";
      restoredData.parametrage.dateLancement = "";
      restoredData.parametrage.date_cloture = "";
      restoredData.parametrage.dateCloture = "";
    }

    const baseTitle = String(source.title || "Autodiagnostic").trim();
    const restoredTitle = /^Restauré\s+-\s+/i.test(baseTitle) ? baseTitle : `Restauré - ${baseTitle}`;
    restoredData.title = restoredTitle;
    restoredData.autodiagTitle = restoredTitle;
    if (restoredData.parametrage && typeof restoredData.parametrage === "object") {
      restoredData.parametrage.nom = restoredTitle;
    }

    const result = await pool.query(
      `UPDATE projects
       SET title = $1,
           status = 'draft',
           data = $2,
           current_step = 'questions',
           share_url = NULL,
           results_url = NULL,
           campaign_start_date = NULL,
           campaign_end_date = NULL,
           unpublished_at = NULL,
           archived_at = NULL,
           published_at = NULL,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [restoredTitle, restoredData, numericId]
    );

    res.json({ ok: true, project: result.rows[0] });
  } catch (err) {
    console.error("PATCH /api/projects/:id/restore", err);
    res.status(500).json({ error: "Erreur restauration projet" });
  }
});

app.post("/api/projects/:id/clone", auth, async (req, res) => {
  const { id } = req.params;

  try {
    const sourceResult = await pool.query(
      `SELECT p.*
       FROM projects p
       LEFT JOIN organizations o ON o.id = p.organization_id
       WHERE p.id = $1
         AND (
           p.user_id = $2
           OR p.created_by = $2
           OR o.created_by = $2
           OR EXISTS (SELECT 1 FROM organization_users ou WHERE ou.organization_id = p.organization_id AND ou.user_id = $2)
           OR EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.role = 'admin')
         )
       LIMIT 1`,
      [id, req.user.id]
    );

    const source = sourceResult.rows[0];

    if (!source) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const sourceStatus = normalizeProjectStatusValue(source.status);
    if (!["sent", "published", "unpublished", "archived"].includes(sourceStatus)) {
      return res.status(400).json({ error: "Le clonage est disponible après transmission, publication, dépublication ou archivage." });
    }

    const clonedData = { ...(source.data || {}) };
    clonedData.clonedFromProjectId = source.id;
    clonedData.configTransmise = false;
    clonedData.config_transmise = false;
    clonedData.submitted = false;
    clonedData.submitted_at = null;
    clonedData.status = "draft";
    clonedData.step = "questions";
    clonedData.current_step = "questions";
    clonedData.shareUrl = "";
    clonedData.share_url = "";
    clonedData.resultsUrl = "";
    clonedData.results_url = "";
    clonedData.campaignStartDate = "";
    clonedData.campaign_start_date = "";
    clonedData.campaignEndDate = "";
    clonedData.campaign_end_date = "";
    if (clonedData.parametrage && typeof clonedData.parametrage === "object") {
      clonedData.parametrage.date_lancement = "";
      clonedData.parametrage.dateLancement = "";
      clonedData.parametrage.date_cloture = "";
      clonedData.parametrage.dateCloture = "";
    }

    const clonedTitle = `Copie de ${source.title || "Autodiagnostic"}`;

    const result = await pool.query(
      `INSERT INTO projects (user_id, title, status, data, created_by, organization_id, current_step, passation_logo_name, passation_logo_data_url)
       VALUES ($1, $2, 'draft', $3, $4, $5, 'questions', $6, $7)
       RETURNING *`,
      [
        source.user_id || req.user.id,
        clonedTitle,
        clonedData,
        req.user.id,
        source.organization_id || null,
        source.passation_logo_name || null,
        source.passation_logo_data_url || null
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
  const finalPassationLogoName = extractPassationLogoName(data || {}, req.body || {});
  const finalPassationLogoDataUrl = extractPassationLogoDataUrl(data || {}, req.body || {});

  const configSent =
    data?.configTransmise === true ||
    data?.config_transmise === true ||
    data?.submitted === true;

  if (!finalStatus) {
    finalStatus = resolveIncomingProjectStatus(configSent ? "sent" : "draft", data || {}, req.body || {});
  }

  const normalizedData = data && typeof data === "object"
    ? {
        ...data,
        campaignStartDate: finalCampaignStartDate || data.campaignStartDate || data.campaign_start_date || "",
        campaignEndDate: finalCampaignEndDate || data.campaignEndDate || data.campaign_end_date || "",
        campaign_start_date: finalCampaignStartDate || data.campaign_start_date || data.campaignStartDate || "",
        campaign_end_date: finalCampaignEndDate || data.campaign_end_date || data.campaignEndDate || "",
        passationLogoName: finalPassationLogoName || data.passationLogoName || data.passation_logo_name || "",
        passationLogoDataUrl: finalPassationLogoDataUrl || data.passationLogoDataUrl || data.passation_logo_data_url || "",
        passation_logo_name: finalPassationLogoName || data.passation_logo_name || data.passationLogoName || "",
        passation_logo_data_url: finalPassationLogoDataUrl || data.passation_logo_data_url || data.passationLogoDataUrl || ""
      }
    : data;

  if (!finalOrganizationId) {
    finalOrganizationId = await getUserPrimaryOrganizationId(req.user.id);
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
         passation_logo_name = COALESCE($8, passation_logo_name),
         passation_logo_data_url = COALESCE($9, passation_logo_data_url),
         updated_at = NOW()
     WHERE id = $10
       AND (
         user_id = $11
         OR created_by = $11
         OR EXISTS (SELECT 1 FROM organization_users ou WHERE ou.organization_id = projects.organization_id AND ou.user_id = $11)
       )
     RETURNING *`,
    [
      title || null,
      normalizedData || null,
      finalOrganizationId || null,
      finalStatus,
      finalStep,
      finalCampaignStartDate,
      finalCampaignEndDate,
      finalPassationLogoName || null,
      finalPassationLogoDataUrl || null,
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
      `SELECT id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at
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
    let whereClause = `
      o.type = 'client'
      AND NOT (
        LOWER(TRIM(o.name)) = LOWER(TRIM(COALESCE(owner.company_name, '')))
        AND COALESCE(o.contact_email, '') = COALESCE(owner.email, '')
        AND COALESCE(owner.role, '') = 'partner'
        AND NOT EXISTS (SELECT 1 FROM projects px WHERE px.organization_id = o.id)
      )
    `;

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
              'data', p.data,
              'current_step', p.current_step,
              'share_url', p.share_url,
              'shareUrl', p.share_url,
              'results_url', p.results_url,
              'resultsUrl', p.results_url,
              'published_at', p.published_at,
              'publishedAt', p.published_at,
              'unpublished_at', p.unpublished_at,
              'unpublishedAt', p.unpublished_at,
              'archived_at', p.archived_at,
              'archivedAt', p.archived_at,
              'campaign_start_date', p.campaign_start_date,
              'campaignStartDate', p.campaign_start_date,
              'campaign_end_date', p.campaign_end_date,
              'campaignEndDate', p.campaign_end_date,
              'passation_logo_name', p.passation_logo_name,
              'passationLogoName', p.passation_logo_name,
              'passation_logo_data_url', p.passation_logo_data_url,
              'passationLogoDataUrl', p.passation_logo_data_url
            )
          ) FILTER (WHERE p.id IS NOT NULL),
          '[]'
        ) AS projects
      FROM organizations o
      LEFT JOIN users owner ON owner.id = o.created_by
      LEFT JOIN projects p ON p.organization_id = o.id
      LEFT JOIN campaigns c ON c.organization_id = o.id
      WHERE ${whereClause}
      GROUP BY o.id, owner.id
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
      u.job_title,
      u.sector,
      u.organization_logo_name,
      u.organization_logo_data_url,
      u.passation_logo_name,
      u.passation_logo_data_url,
      u.role,
      u.status,
      u.must_change_password,
      u.passations_quota,
      u.passations_used,
      u.created_at,
      COUNT(DISTINCT p.id)::int AS projects_count,
      MAX(p.updated_at) AS last_project_update,
      primary_ou.organization_id,
      org.name AS organization_name
    FROM users u
    LEFT JOIN projects p ON p.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT ou.organization_id
      FROM organization_users ou
      WHERE ou.user_id = u.id
      ORDER BY ou.created_at DESC, ou.id DESC
      LIMIT 1
    ) primary_ou ON true
    LEFT JOIN organizations org ON org.id = primary_ou.organization_id
    GROUP BY u.id, primary_ou.organization_id, org.name
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
        jobTitle: row.job_title || "",
        sector: row.sector || "",
        organizationLogoName: row.organization_logo_name || "",
        organizationLogoDataUrl: row.organization_logo_data_url || "",
        passationLogoName: row.passation_logo_name || "",
        passationLogoDataUrl: row.passation_logo_data_url || "",
        role: row.role || "client",
        status: row.status || "active",
        mustChangePassword: row.must_change_password === true,
        passationsQuota: quota,
        passationsUsed: used,
        passationsRemaining: Math.max(0, quota - used),
        organizationId: row.organization_id || null,
        organizationName: row.organization_name || "",
        createdAt: row.created_at,
        projectsCount: row.projects_count,
        lastProjectUpdate: row.last_project_update
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
        u.role AS owner_role,
        COUNT(DISTINCT p.id)::int AS projects_count,
        COALESCE(
          json_agg(
            DISTINCT jsonb_build_object(
              'id', ou_user.id,
              'email', ou_user.email,
              'firstName', ou_user.first_name,
              'lastName', ou_user.last_name,
              'companyName', ou_user.company_name,
              'jobTitle', ou_user.job_title,
              'role', ou.role
            )
          ) FILTER (WHERE ou_user.id IS NOT NULL),
          '[]'
        ) AS organization_users
      FROM organizations o
      LEFT JOIN users u ON u.id = o.created_by
      LEFT JOIN projects p ON p.organization_id = o.id
      LEFT JOIN organization_users ou ON ou.organization_id = o.id
      LEFT JOIN users ou_user ON ou_user.id = ou.user_id
      WHERE o.type = 'client'
        AND NOT (
          LOWER(TRIM(o.name)) = LOWER(TRIM(COALESCE(u.company_name, '')))
          AND COALESCE(o.contact_email, '') = COALESCE(u.email, '')
          AND COALESCE(u.role, '') = 'partner'
          AND NOT EXISTS (SELECT 1 FROM projects px WHERE px.organization_id = o.id)
        )
      GROUP BY o.id, u.id
      ORDER BY o.created_at DESC
    `);

    res.json({
      organizations: result.rows.map((row) => ({
        ...formatOrganization(row),
        ownerEmail: row.owner_email || "",
        ownerRole: row.owner_role || "",
        ownerCompanyName: row.owner_company_name || "",
        ownerName:
          `${row.owner_first_name || ""} ${row.owner_last_name || ""}`.trim() ||
          row.owner_company_name ||
          row.owner_email ||
          "—",
        projectsCount: Number(row.projects_count || 0),
        users: Array.isArray(row.organization_users) ? row.organization_users : []
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
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
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
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
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

app.patch("/api/admin/users/:id/profile", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { companyName, jobTitle, sector } = req.body;

  try {
    const current = await pool.query(
      `SELECT company_name, job_title, sector FROM users WHERE id = $1 LIMIT 1`,
      [id]
    );

    if (!current.rows[0]) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    const result = await pool.query(
      `UPDATE users
       SET company_name = $1,
           job_title = $2,
           sector = $3
       WHERE id = $4
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
      [
        companyName !== undefined ? companyName || "" : current.rows[0].company_name || "",
        jobTitle !== undefined ? jobTitle || "" : current.rows[0].job_title || "",
        sector !== undefined ? sector || "" : current.rows[0].sector || "",
        id
      ]
    );

    res.json({ user: formatUser(result.rows[0]) });
  } catch (err) {
    console.error("Erreur mise à jour profil utilisateur admin", err);
    res.status(500).json({ error: "Erreur mise à jour profil utilisateur" });
  }
});

app.patch("/api/admin/users/:id/status", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const safeStatus = String(status || "").toLowerCase();

  if (!["active", "disabled", "deleted"].includes(safeStatus)) {
    return res.status(400).json({ error: "Statut utilisateur invalide" });
  }

  if (Number(id) === Number(req.user.id) && safeStatus !== "active") {
    return res.status(400).json({ error: "Vous ne pouvez pas désactiver ou supprimer votre propre compte admin" });
  }

  try {
    const existing = await pool.query(
      `SELECT id, role FROM users WHERE id = $1 LIMIT 1`,
      [id]
    );

    if (!existing.rows[0]) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    if (existing.rows[0].role === "admin" && safeStatus !== "active") {
      return res.status(403).json({ error: "Par sécurité, un compte admin ne peut pas être désactivé ou supprimé depuis cette interface" });
    }

    const result = await pool.query(
      `UPDATE users
       SET status = $1
       WHERE id = $2
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
      [safeStatus, id]
    );

    res.json({ ok: true, user: formatUser(result.rows[0]) });
  } catch (err) {
    console.error("Erreur changement statut utilisateur", err);
    res.status(500).json({ error: "Erreur changement statut utilisateur" });
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

app.post("/api/admin/organizations/:id/users", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { email, password, firstName, lastName, jobTitle, sector, role } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email et mot de passe requis" });
  }

  try {
    const orgResult = await pool.query(`SELECT * FROM organizations WHERE id = $1 LIMIT 1`, [id]);
    const org = orgResult.rows[0];
    if (!org) return res.status(404).json({ error: "Organisation introuvable" });

    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, company_name, job_title, sector, role, status, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'client', 'active', true)
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
      [
        email.toLowerCase(),
        passwordHash,
        firstName || "",
        lastName || "",
        org.name || "",
        jobTitle || "",
        sector || ""
      ]
    );

    const user = userResult.rows[0];
    await addUserToOrganization({ organizationId: id, userId: user.id, role: role || "member" });

    const loginUrl = `${FRONTEND_URL}/login.html?redirect=account.html%3Ftab%3Dsecurite%26firstLogin%3D1`;
    const mailResult = await sendTransactionalEmail({
      to: user.email,
      subject: "Votre accès Shift Studio est créé",
      text:
`Bonjour ${firstName || ""},

Votre compte Shift Studio a été créé et rattaché à l’entreprise ${org.name || ""}.

Vous pouvez vous connecter ici :
${loginUrl}

Identifiant : ${user.email}
Mot de passe temporaire : ${password}

Après connexion avec ce mot de passe temporaire, vous serez invité à choisir votre propre mot de passe.

L’équipe Into The Shift`,
      html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.5">
  <p>Bonjour ${escapeHtml(firstName || "")},</p>
  <p>Votre compte <strong>Shift Studio</strong> a été créé et rattaché à l’entreprise <strong>${escapeHtml(org.name || "")}</strong>.</p>
  <p><a href="${loginUrl}" style="display:inline-block;background:#0d4c72;color:#ffffff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Me connecter</a></p>
  <p><strong>Identifiant :</strong> ${escapeHtml(user.email)}</p>
  <p><strong>Mot de passe temporaire :</strong> ${escapeHtml(password)}</p>
  <p>Après connexion avec ce mot de passe temporaire, vous serez invité à choisir votre propre mot de passe.</p>
  <p>L’équipe Into The Shift</p>
</div>`
    });

    res.status(201).json({
      user: formatUser({ ...user, organization_id: Number(id) }),
      emailSent: mailResult.sent,
      emailStatus: mailResult.reason || "SENT"
    });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Cet email existe déjà" });
    console.error("POST /api/admin/organizations/:id/users", err);
    res.status(500).json({ error: "Erreur création utilisateur rattaché" });
  }
});

app.patch("/api/admin/users/:id/organization", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { organizationId, role } = req.body;

  if (!organizationId) return res.status(400).json({ error: "Organisation requise" });

  try {
    const userResult = await pool.query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [id]);
    if (!userResult.rows[0]) return res.status(404).json({ error: "Utilisateur introuvable" });

    const orgResult = await pool.query(`SELECT * FROM organizations WHERE id = $1 LIMIT 1`, [organizationId]);
    if (!orgResult.rows[0]) return res.status(404).json({ error: "Organisation introuvable" });

    await addUserToOrganization({ organizationId, userId: id, role: role || "member" });

    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /api/admin/users/:id/organization", err);
    res.status(500).json({ error: "Erreur rattachement utilisateur" });
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
      p.current_step,
      p.share_url,
      p.results_url,
      p.published_at,
      p.unpublished_at,
      p.archived_at,
      p.campaign_start_date,
      p.campaign_end_date,
      p.passation_logo_name,
      p.passation_logo_data_url,
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
        currentStep: row.current_step || data.step || data.current_step || data.currentStep || "",
        shareUrl: row.share_url || "",
        share_url: row.share_url || "",
        resultsUrl: row.results_url || "",
        results_url: row.results_url || "",
        publishedAt: row.published_at || null,
        published_at: row.published_at || null,
        unpublishedAt: row.unpublished_at || null,
        unpublished_at: row.unpublished_at || null,
        archivedAt: row.archived_at || null,
        archived_at: row.archived_at || null,
        campaignStartDate: row.campaign_start_date || extractCampaignStartDate(data, {}) || null,
        campaignEndDate: row.campaign_end_date || extractCampaignEndDate(data, {}) || null,
        campaign_start_date: row.campaign_start_date || extractCampaignStartDate(data, {}) || null,
        campaign_end_date: row.campaign_end_date || extractCampaignEndDate(data, {}) || null,
        passationLogoName: row.passation_logo_name || data.passationLogoName || data.passation_logo_name || data.parametrage?.passationLogoName || data.parametrage?.passation_logo_name || "",
        passationLogoDataUrl: row.passation_logo_data_url || data.passationLogoDataUrl || data.passation_logo_data_url || data.parametrage?.passationLogoDataUrl || data.parametrage?.passation_logo_data_url || "",
        passation_logo_name: row.passation_logo_name || data.passation_logo_name || data.parametrage?.passation_logo_name || "",
        passation_logo_data_url: row.passation_logo_data_url || data.passation_logo_data_url || data.parametrage?.passation_logo_data_url || "",
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

app.get("/api/admin/projects/:id", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`
      SELECT
        p.*,
        o.name AS organization_name,
        o.passations_pack AS organization_passations_pack,
        o.passations_quota AS organization_passations_quota,
        o.passations_used AS organization_passations_used,
        u.email,
        u.first_name,
        u.last_name,
        u.company_name,
        creator.email AS creator_email,
        creator.first_name AS creator_first_name,
        creator.last_name AS creator_last_name,
        creator.company_name AS creator_company_name,
        creator.role AS creator_role,
        partner.id AS partner_id,
        partner.email AS partner_email,
        partner.company_name AS partner_company_name
      FROM projects p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN organizations o ON o.id = p.organization_id
      LEFT JOIN users creator ON creator.id = COALESCE(p.created_by, p.user_id)
      LEFT JOIN users partner ON partner.id = o.created_by AND partner.role = 'partner'
      WHERE p.id = $1
      LIMIT 1
    `, [id]);

    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "Projet introuvable" });

    const data = row.data || {};
    res.json({
      project: {
        ...row,
        organizationName: row.organization_name || row.company_name || "",
        shareUrl: row.share_url || "",
        resultsUrl: row.results_url || "",
        publishedAt: row.published_at || null,
        unpublishedAt: row.unpublished_at || null,
        archivedAt: row.archived_at || null,
        archived_at: row.archived_at || null,
        campaignStartDate: row.campaign_start_date || extractCampaignStartDate(data, {}) || null,
        campaignEndDate: row.campaign_end_date || extractCampaignEndDate(data, {}) || null,
        campaign_start_date: row.campaign_start_date || extractCampaignStartDate(data, {}) || null,
        campaign_end_date: row.campaign_end_date || extractCampaignEndDate(data, {}) || null,
        passationLogoName: row.passation_logo_name || data.passationLogoName || data.passation_logo_name || data.parametrage?.passationLogoName || data.parametrage?.passation_logo_name || "",
        passationLogoDataUrl: row.passation_logo_data_url || data.passationLogoDataUrl || data.passation_logo_data_url || data.parametrage?.passationLogoDataUrl || data.parametrage?.passation_logo_data_url || "",
        passation_logo_name: row.passation_logo_name || data.passation_logo_name || data.parametrage?.passation_logo_name || "",
        passation_logo_data_url: row.passation_logo_data_url || data.passation_logo_data_url || data.parametrage?.passation_logo_data_url || "",
        creatorEmail: row.creator_email || row.email || "",
        creatorCompanyName: row.creator_company_name || row.company_name || "",
        creatorRole: row.creator_role || "",
        partnerId: row.partner_id || null,
        partnerEmail: row.partner_email || "",
        partnerName: row.partner_company_name || row.partner_email || ""
      }
    });
  } catch (err) {
    console.error("GET /api/admin/projects/:id", err);
    res.status(500).json({ error: "Erreur chargement projet admin", detail: err.message || "" });
  }
});

app.patch("/api/admin/projects/:id/status", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = ["draft", "sent", "published", "unpublished", "archived"];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: "Statut invalide" });
  }

  try {
    const currentResult = await pool.query(`SELECT status FROM projects WHERE id = $1 LIMIT 1`, [id]);
    if (!currentResult.rows[0]) {
      return res.status(404).json({ error: "Projet introuvable" });
    }
    const currentStatus = normalizeProjectStatusValue(currentResult.rows[0].status);
    if (status === "archived" && currentStatus !== "unpublished") {
      return res.status(400).json({ error: "Un projet doit d’abord être dépublié avant d’être archivé." });
    }

    const result = await pool.query(
      `UPDATE projects
       SET status = $1,
           unpublished_at = CASE WHEN $1 = 'unpublished' THEN COALESCE(unpublished_at, NOW()) ELSE unpublished_at END,
           archived_at = CASE WHEN $1 = 'archived' THEN COALESCE(archived_at, NOW()) ELSE NULL END,
           published_at = CASE WHEN $1 = 'published' THEN COALESCE(published_at, NOW()) ELSE published_at END,
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

  const allowedStatuses = ["draft", "sent", "published", "unpublished", "archived"];

  if (!allowedStatuses.includes(finalStatus)) {
    return res.status(400).json({ error: "Statut invalide" });
  }

  if (finalCampaignStartDate && finalCampaignEndDate && finalCampaignStartDate > finalCampaignEndDate) {
    return res.status(400).json({ error: "La date de début ne peut pas être postérieure à la date de fin." });
  }

  if (finalStatus === "published" && (!finalShareUrl || !finalResultsUrl)) {
    return res.status(400).json({ error: "URL de diffusion et URL résultats obligatoires pour publier." });
  }

  if (finalStatus === "published" && (!isValidHttpsUrl(finalShareUrl) || !isValidHttpsUrl(finalResultsUrl))) {
    return res.status(400).json({ error: "Les URLs doivent être complètes et commencer par https://" });
  }

  if ((finalShareUrl && !isValidHttpsUrl(finalShareUrl)) || (finalResultsUrl && !isValidHttpsUrl(finalResultsUrl))) {
    return res.status(400).json({ error: "Les URLs doivent être complètes et commencer par https://" });
  }

  try {
    const existingResult = await pool.query(
      `SELECT status, share_url, results_url FROM projects WHERE id = $1 LIMIT 1`,
      [id]
    );

    if (!existingResult.rows[0]) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const existing = existingResult.rows[0];
    const currentStatus = normalizeProjectStatusValue(existing.status);

    if (finalStatus === "archived" && currentStatus !== "unpublished") {
      return res.status(400).json({ error: "Un projet doit d’abord être dépublié avant d’être archivé." });
    }

    const nextShareUrl = (finalStatus === "published" || finalStatus === "unpublished")
      ? (finalShareUrl || existing.share_url || "")
      : (finalShareUrl || existing.share_url || "");

    const nextResultsUrl = (finalStatus === "published" || finalStatus === "unpublished")
      ? (finalResultsUrl || existing.results_url || "")
      : (finalResultsUrl || existing.results_url || "");

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
          ELSE unpublished_at
        END,
        archived_at = CASE
          WHEN $1 = 'archived' THEN COALESCE(archived_at, NOW())
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


app.patch("/api/projects/:id/passation-logo", auth, async (req, res) => {
  const { id } = req.params;
  const passationLogoName = req.body.passationLogoName || req.body.passation_logo_name || "";
  const passationLogoDataUrl = req.body.passationLogoDataUrl || req.body.passation_logo_data_url || "";

  try {
    const result = await pool.query(`
      UPDATE projects p
      SET passation_logo_name = $1,
          passation_logo_data_url = $2,
          data = COALESCE(p.data, '{}'::jsonb) || jsonb_build_object(
            'passationLogoName', $1,
            'passationLogoDataUrl', $2,
            'passation_logo_name', $1,
            'passation_logo_data_url', $2
          ),
          updated_at = NOW()
      FROM organizations o
      WHERE p.id = $3
        AND o.id = p.organization_id
        AND (
          p.user_id = $4
          OR p.created_by = $4
          OR o.created_by = $4
          OR EXISTS (SELECT 1 FROM users u WHERE u.id = $4 AND u.role = 'admin')
        )
      RETURNING p.*
    `, [passationLogoName || null, passationLogoDataUrl || null, id, req.user.id]);

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Projet introuvable ou non autorisé" });
    }

    res.json({ ok: true, project: result.rows[0] });
  } catch (err) {
    console.error("PATCH /api/projects/:id/passation-logo", err);
    res.status(500).json({ error: "Erreur mise à jour logo passation" });
  }
});

app.patch("/api/admin/projects/:id/passation-logo", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const passationLogoName = req.body.passationLogoName || req.body.passation_logo_name || "";
  const passationLogoDataUrl = req.body.passationLogoDataUrl || req.body.passation_logo_data_url || "";

  try {
    const result = await pool.query(`
      UPDATE projects
      SET passation_logo_name = $1,
          passation_logo_data_url = $2,
          data = COALESCE(data, '{}'::jsonb) || jsonb_build_object(
            'passationLogoName', $1,
            'passationLogoDataUrl', $2,
            'passation_logo_name', $1,
            'passation_logo_data_url', $2
          ),
          updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `, [passationLogoName || null, passationLogoDataUrl || null, id]);

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    res.json({ ok: true, project: result.rows[0] });
  } catch (err) {
    console.error("PATCH /api/admin/projects/:id/passation-logo", err);
    res.status(500).json({ error: "Erreur mise à jour logo passation admin" });
  }
});

app.delete("/api/admin/projects/:id", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const numericId = Number(id);

  if (!Number.isInteger(numericId) || numericId <= 0) {
    return res.status(400).json({ error: "ID projet invalide." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT id, title FROM projects WHERE id = $1 FOR UPDATE`,
      [numericId]
    );

    if (!existing.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const deletedDependencies = [];

    // Suppression explicite des dépendances connues.
    // Important : certaines tables peuvent avoir été créées avant l'ajout de ON DELETE CASCADE.
    const campaignsDeleted = await client.query(
      `DELETE FROM campaigns WHERE project_id = $1 RETURNING id`,
      [numericId]
    );
    deletedDependencies.push({ table: "campaigns", count: campaignsDeleted.rowCount });

    // Sécurité supplémentaire : si d'autres tables ajoutées plus tard référencent projects(id),
    // on supprime aussi les lignes dépendantes avant de supprimer le projet.
    const fkResult = await client.query(`
      SELECT
        ns.nspname AS schema_name,
        child.relname AS table_name,
        att.attname AS column_name
      FROM pg_constraint con
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = child.relnamespace
      JOIN unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord) ON true
      JOIN pg_attribute att ON att.attrelid = child.oid AND att.attnum = cols.attnum
      WHERE con.contype = 'f'
        AND parent.relname = 'projects'
        AND ns.nspname = 'public'
        AND child.relname <> 'projects'
    `);

    for (const fk of fkResult.rows) {
      const tableName = String(fk.table_name || "");
      const columnName = String(fk.column_name || "");

      // campaigns vient déjà d'être traité explicitement.
      if (!tableName || !columnName || tableName === "campaigns") continue;

      const tableIdent = `"${tableName.replace(/"/g, '""')}"`;
      const columnIdent = `"${columnName.replace(/"/g, '""')}"`;
      const depDeleted = await client.query(
        `DELETE FROM ${tableIdent} WHERE ${columnIdent} = $1`,
        [numericId]
      );
      deletedDependencies.push({ table: tableName, column: columnName, count: depDeleted.rowCount });
    }

    const deleted = await client.query(
      `DELETE FROM projects
       WHERE id = $1
       RETURNING id, title`,
      [numericId]
    );

    if (!deleted.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Projet introuvable au moment de la suppression" });
    }

    const check = await client.query(`SELECT id FROM projects WHERE id = $1`, [numericId]);

    if (check.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: "Suppression non confirmée en base." });
    }

    await client.query("COMMIT");

    res.json({
      ok: true,
      deletedProject: deleted.rows[0],
      deletedDependencies
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erreur suppression projet admin", {
      projectId: numericId,
      code: err.code,
      constraint: err.constraint,
      table: err.table,
      detail: err.detail,
      message: err.message
    });
    res.status(500).json({
      error: "Erreur suppression projet",
      detail: err.detail || err.message || "",
      code: err.code || "",
      constraint: err.constraint || "",
      table: err.table || ""
    });
  } finally {
    client.release();
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
    jobTitle,
    sector,
    role,
    organizationId
  } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email et mot de passe requis" });
  }

  const safeRole = ["client", "admin", "partner"].includes(role) ? role : "client";
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, company_name, job_title, sector, role, status, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', true)
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
      [
        email.toLowerCase(),
        passwordHash,
        firstName || "",
        lastName || "",
        companyName || "",
        jobTitle || "",
        sector || "",
        safeRole
      ]
    );

    const user = userResult.rows[0];

    if (safeRole === "client") {
      let shouldAttachToExistingOrganization = false;

      if (organizationId) {
        const orgCheck = await pool.query(
          `SELECT id, name FROM organizations WHERE id = $1 LIMIT 1`,
          [organizationId]
        );
        const orgName = String(orgCheck.rows[0]?.name || "").trim().toLowerCase();
        const requestedCompany = String(companyName || "").trim().toLowerCase();

        // Protection anti-régression : si l'admin a encore un ancien client sélectionné
        // dans le navigateur, on ne rattache pas le nouveau compte à cette ancienne
        // organisation quand le nom d'entreprise ne correspond pas.
        shouldAttachToExistingOrganization = Boolean(
          orgCheck.rows[0] && (!requestedCompany || orgName === requestedCompany)
        );
      }

      if (shouldAttachToExistingOrganization) {
        await addUserToOrganization({ organizationId, userId: user.id, role: "member" });
      } else if (companyName) {
        await ensureDirectClientOrganization(user.id);
      }
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
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
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

  try {
    const existing = await pool.query(
      `SELECT id, role, status FROM users WHERE id = $1 LIMIT 1`,
      [id]
    );

    if (!existing.rows[0]) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    if (existing.rows[0].role === "admin") {
      return res.status(403).json({ error: "Par sécurité, un compte admin ne peut pas être supprimé depuis cette interface" });
    }

    const deletedUser = await pool.query(
      `UPDATE users
       SET status = 'deleted'
       WHERE id = $1
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
      [id]
    );

    res.json({
      ok: true,
      deletedUser: formatUser(deletedUser.rows[0])
    });
  } catch (err) {
    console.error("Erreur suppression utilisateur", err);
    res.status(500).json({ error: "Erreur suppression utilisateur" });
  }
});



function buildTransmissionEmailContext(body = {}) {
  const payload = body.payload && typeof body.payload === "object" ? body.payload : body;
  const clientInfo = payload.client_info || payload.clientInfo || {};

  const clientEmail =
    payload.clientEmail ||
    payload.client_email ||
    clientInfo.email ||
    "";

  const clientName =
    payload.clientName ||
    payload.client_name ||
    [clientInfo.prenom || clientInfo.firstName || clientInfo.first_name || "", clientInfo.nom || clientInfo.lastName || clientInfo.last_name || ""].filter(Boolean).join(" ").trim() ||
    clientInfo.name ||
    "";

  const companyName =
    payload.companyName ||
    payload.company_name ||
    payload.entreprise ||
    clientInfo.entreprise ||
    clientInfo.companyName ||
    "";

  const autodiagTitle =
    payload.autodiagTitle ||
    payload.autodiag_title ||
    payload.titre_autodiag ||
    payload.titre_repondants ||
    "votre autodiagnostic";

  const recapHtml =
    payload.recap_html ||
    payload.recapHtml ||
    payload.pdf_html ||
    payload.htmlRecap ||
    "";

  const excelHtml =
    payload.excel_html ||
    payload.excelHtml ||
    payload.excel?.data ||
    payload.data ||
    "";

  const safeCompany = String(companyName || "client")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "client";

  const excelFilename =
    payload.excel_filename ||
    payload.excelFilename ||
    payload.excel?.filename ||
    `configuration-shift-studio-${safeCompany}.xls`;

  const recapFilename =
    payload.pdf_filename ||
    payload.recap_filename ||
    payload.recap?.filename ||
    `recapitulatif-shift-studio-${safeCompany}.html`;

  const subject = payload.subject || `Récapitulatif de votre configuration Shift Studio — ${autodiagTitle}`;

  return {
    payload,
    clientInfo,
    clientEmail,
    clientName,
    companyName,
    autodiagTitle,
    recapHtml,
    recapFilename,
    excelHtml,
    excelFilename,
    subject
  };
}

function buildClientRecapEmailHtml(ctx) {
  const helloName = ctx.clientName || "";
  const introHtml = `
    <div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55">
      <p>Bonjour ${escapeHtml(helloName)},</p>
      <p>Votre configuration d’autodiagnostic <strong>${escapeHtml(ctx.autodiagTitle)}</strong> a bien été transmise à Into The Shift.</p>
      ${ctx.companyName ? `<p><strong>Entreprise :</strong> ${escapeHtml(ctx.companyName)}</p>` : ""}
      <p>Notre équipe va vérifier les éléments transmis, préparer la mise en ligne et vous confirmer le lien de passation définitif.</p>
      <p>Vous trouverez ci-dessous le récapitulatif de votre configuration.</p>
      <hr style="border:none;border-top:1px solid #dce5ee;margin:24px 0">
    </div>
  `;

  const outroHtml = `
    <div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55">
      <hr style="border:none;border-top:1px solid #dce5ee;margin:24px 0">
      <p>Pour toute correction ou précision, contactez <a href="mailto:contact@intotheshift.io">contact@intotheshift.io</a>.</p>
      <p>L’équipe Into The Shift</p>
    </div>
  `;

  return ctx.recapHtml
    ? `${introHtml}${ctx.recapHtml}${outroHtml}`
    : `${introHtml}<p style="font-family:Arial,sans-serif;color:#18375d">Le récapitulatif détaillé n’a pas été joint à cette transmission.</p>${outroHtml}`;
}

function buildClientRecapEmailText(ctx) {
  return `Bonjour ${ctx.clientName || ""},

Votre configuration d’autodiagnostic "${ctx.autodiagTitle}" a bien été transmise à Into The Shift.
${ctx.companyName ? `Entreprise : ${ctx.companyName}\n` : ""}
Notre équipe va vérifier les éléments transmis, préparer la mise en ligne et vous confirmer le lien de passation définitif.

Pour toute correction ou précision, contactez contact@intotheshift.io.

L’équipe Into The Shift`;
}

function extractProjectIdFromTransmissionBody(body = {}) {
  return (
    body.projectId ||
    body.project_id ||
    body.currentProjectId ||
    body.current_project_id ||
    body.currentAdId ||
    body.current_ad_id ||
    body.data?.projectId ||
    body.data?.project_id ||
    body.data?.currentAdId ||
    body.state?.projectId ||
    body.state?.project_id ||
    body.payload?.projectId ||
    body.payload?.project_id ||
    null
  );
}

async function markProjectAsSentFromTransmission(req) {
  const projectId = extractProjectIdFromTransmissionBody(req.body || {});
  if (!projectId) return null;

  const result = await pool.query(
    `UPDATE projects
     SET status = 'sent',
         data = COALESCE(data, '{}'::jsonb) || jsonb_build_object(
           'configTransmise', true,
           'config_transmise', true,
           'submitted', true,
           'submitted_at', NOW(),
           'status', 'sent'
         ),
         current_step = 'validation',
         updated_at = NOW()
     WHERE id = $1
       AND (
         user_id = $2
         OR created_by = $2
         OR EXISTS (SELECT 1 FROM organization_users ou WHERE ou.organization_id = projects.organization_id AND ou.user_id = $2)
         OR EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.role = 'admin')
       )
     RETURNING id, status`,
    [projectId, req.user.id]
  );

  return result.rows[0] || null;
}

app.post("/api/transmissions/submit", auth, async (req, res) => {
  try {
    const ctx = buildTransmissionEmailContext(req.body || {});

    if (!ctx.clientEmail) {
      return res.status(400).json({
        ok: false,
        clientEmailSent: false,
        adminEmailSent: false,
        error: "Email client manquant"
      });
    }

    if (!ctx.excelHtml) {
      return res.status(400).json({
        ok: false,
        clientEmailSent: false,
        adminEmailSent: false,
        error: "Fichier Excel manquant"
      });
    }

    const clientHtml = buildClientRecapEmailHtml(ctx);
    const clientText = buildClientRecapEmailText(ctx);

    const clientMail = await sendTransactionalEmail({
      to: ctx.clientEmail,
      subject: ctx.subject,
      text: clientText,
      html: clientHtml,
      attachments: ctx.recapHtml ? [
        {
          filename: ctx.recapFilename,
          content: ctx.recapHtml,
          contentType: "text/html; charset=utf-8"
        }
      ] : []
    });

    const adminSubject = `Nouvelle configuration à intégrer — ${ctx.companyName || "Client"} — ${ctx.autodiagTitle}`;
    const adminHtml = `
      <div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55">
        <p><strong>Nouvelle configuration transmise depuis Shift Studio.</strong></p>
        <p>
          <strong>Entreprise :</strong> ${escapeHtml(ctx.companyName || "—")}<br>
          <strong>Contact :</strong> ${escapeHtml(ctx.clientName || "—")}<br>
          <strong>Email :</strong> ${escapeHtml(ctx.clientEmail || "—")}<br>
          <strong>Autodiagnostic :</strong> ${escapeHtml(ctx.autodiagTitle || "—")}
        </p>
        <p>Le fichier Excel de configuration est joint à cet email. Le récapitulatif client est également joint et repris ci-dessous.</p>
        <hr style="border:none;border-top:1px solid #dce5ee;margin:24px 0">
        ${ctx.recapHtml || ""}
      </div>
    `;

    const adminMail = await sendTransactionalEmail({
      to: "contact@intotheshift.io",
      subject: adminSubject,
      text:
`Nouvelle configuration transmise depuis Shift Studio.

Entreprise : ${ctx.companyName || "—"}
Contact : ${ctx.clientName || "—"}
Email : ${ctx.clientEmail || "—"}
Autodiagnostic : ${ctx.autodiagTitle || "—"}

Le fichier Excel de configuration est joint à cet email.`,
      html: adminHtml,
      attachments: [
        {
          filename: ctx.excelFilename,
          content: ctx.excelHtml,
          contentType: "application/vnd.ms-excel; charset=utf-8"
        },
        ...(ctx.recapHtml ? [{
          filename: ctx.recapFilename,
          content: ctx.recapHtml,
          contentType: "text/html; charset=utf-8"
        }] : [])
      ]
    });

    console.log("TRANSMISSION SUBMIT EMAIL STATUS", {
      clientEmail: ctx.clientEmail,
      clientEmailSent: clientMail.sent,
      clientEmailStatus: clientMail.reason || "SENT",
      adminEmail: "contact@intotheshift.io",
      adminEmailSent: adminMail.sent,
      adminEmailStatus: adminMail.reason || "SENT",
      excelFilename: ctx.excelFilename,
      recapFilename: ctx.recapFilename
    });

    const projectStatusUpdate = await markProjectAsSentFromTransmission(req);

    return res.json({
      ok: clientMail.sent && adminMail.sent,
      clientEmailSent: clientMail.sent,
      clientEmailStatus: clientMail.reason || "SENT",
      adminEmailSent: adminMail.sent,
      adminEmailStatus: adminMail.reason || "SENT",
      excelFilename: ctx.excelFilename,
      recapFilename: ctx.recapFilename,
      projectStatusUpdated: Boolean(projectStatusUpdate),
      projectStatus: projectStatusUpdate?.status || null
    });
  } catch (err) {
    console.error("Erreur /api/transmissions/submit", err);
    return res.status(500).json({
      ok: false,
      clientEmailSent: false,
      adminEmailSent: false,
      error: "Erreur transmission email backend"
    });
  }
});

app.post("/api/transmissions/client-recap", auth, async (req, res) => {
  try {
    const body = req.body || {};
    const clientInfo = body.client_info || body.clientInfo || {};

    const clientEmail =
      body.clientEmail ||
      body.client_email ||
      clientInfo.email ||
      "";

    const clientName =
      body.clientName ||
      body.client_name ||
      [clientInfo.prenom || clientInfo.firstName || clientInfo.first_name || "", clientInfo.nom || clientInfo.lastName || clientInfo.last_name || ""].filter(Boolean).join(" ").trim() ||
      clientInfo.name ||
      "";

    const companyName =
      body.companyName ||
      body.company_name ||
      body.entreprise ||
      clientInfo.entreprise ||
      clientInfo.companyName ||
      "";

    const autodiagTitle =
      body.autodiagTitle ||
      body.autodiag_title ||
      body.titre_autodiag ||
      body.titre_repondants ||
      "votre autodiagnostic";

    const recapHtml =
      body.recap_html ||
      body.recapHtml ||
      body.pdf_html ||
      body.htmlRecap ||
      "";

    const requestedSubject = body.subject || "";

    if (!clientEmail) {
      return res.status(400).json({
        ok: false,
        emailSent: false,
        emailStatus: "MISSING_CLIENT_EMAIL",
        error: "Email client manquant"
      });
    }

    const helloName = clientName || "";
    const subject = requestedSubject || `Récapitulatif de votre configuration Shift Studio — ${autodiagTitle}`;

    const introHtml = `
      <div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55">
        <p>Bonjour ${escapeHtml(helloName)},</p>
        <p>Votre configuration d’autodiagnostic <strong>${escapeHtml(autodiagTitle)}</strong> a bien été transmise à Into The Shift.</p>
        ${companyName ? `<p><strong>Entreprise :</strong> ${escapeHtml(companyName)}</p>` : ""}
        <p>Notre équipe va vérifier les éléments transmis, préparer la mise en ligne et vous confirmer le lien de passation définitif.</p>
        <p>Vous trouverez ci-dessous le récapitulatif de votre configuration.</p>
        <hr style="border:none;border-top:1px solid #dce5ee;margin:24px 0">
      </div>
    `;

    const outroHtml = `
      <div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55">
        <hr style="border:none;border-top:1px solid #dce5ee;margin:24px 0">
        <p>Pour toute correction ou précision, contactez <a href="mailto:contact@intotheshift.io">contact@intotheshift.io</a>.</p>
        <p>L’équipe Into The Shift</p>
      </div>
    `;

    const html = recapHtml
      ? `${introHtml}${recapHtml}${outroHtml}`
      : `${introHtml}<p style="font-family:Arial,sans-serif;color:#18375d">Le récapitulatif détaillé n’a pas été joint à cette transmission.</p>${outroHtml}`;

    const text = `Bonjour ${helloName},

Votre configuration d’autodiagnostic "${autodiagTitle}" a bien été transmise à Into The Shift.
${companyName ? `Entreprise : ${companyName}\n` : ""}
Notre équipe va vérifier les éléments transmis, préparer la mise en ligne et vous confirmer le lien de passation définitif.

Pour toute correction ou précision, contactez contact@intotheshift.io.

L’équipe Into The Shift`;

    const recipients = [...new Set([clientEmail, "contact@intotheshift.io"].filter(Boolean))];

    const mailResult = await sendTransactionalEmail({
      to: recipients.join(","),
      subject,
      text,
      html
    });

    console.log("CLIENT RECAP EMAIL STATUS", {
      to: recipients,
      emailSent: mailResult.sent,
      emailStatus: mailResult.reason || "SENT"
    });

    return res.json({
      ok: mailResult.sent,
      emailSent: mailResult.sent,
      emailStatus: mailResult.reason || "SENT"
    });
  } catch (err) {
    console.error("Erreur /api/transmissions/client-recap", err);
    return res.status(500).json({
      ok: false,
      emailSent: false,
      emailStatus: "SERVER_ERROR",
      error: "Erreur envoi email récapitulatif client"
    });
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

