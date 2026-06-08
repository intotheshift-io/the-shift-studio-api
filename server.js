import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { createCampaignAlerts } from "./campaign-alerts.js";
import { createPackAlerts } from "./pack-alerts.js";

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
    profilePhotoName: user.profile_photo_name || "",
    profilePhotoDataUrl: user.profile_photo_data_url || "",
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
    packExpiresAt: org.pack_expires_at || null,
    pack_expires_at: org.pack_expires_at || null,
    packExpiredProcessedAt: org.pack_expired_processed_at || null,
    pack_expired_processed_at: org.pack_expired_processed_at || null,
    packUpgradeRequested: org.pack_upgrade_requested === true,
    packUpgradeStatus: org.pack_upgrade_status || "",
    packUpgradeChoice: org.pack_upgrade_choice || "",
    packUpgradeAmount: org.pack_upgrade_amount === null || org.pack_upgrade_amount === undefined ? null : Number(org.pack_upgrade_amount || 0),
    packUpgradeTotalAfter: org.pack_upgrade_total_after === null || org.pack_upgrade_total_after === undefined ? null : Number(org.pack_upgrade_total_after || 0),
    packUpgradeUnlimited: org.pack_upgrade_unlimited === true,
    packUpgradeRequestedByEmail: org.pack_upgrade_requested_by_email || "",
    packUpgradeRequestedAt: org.pack_upgrade_requested_at || null,
    packUpgradeSourceProjectId: org.pack_upgrade_source_project_id || null,
    packUpgradeRequest: org.pack_upgrade_requested === true ? {
      requested: true,
      status: org.pack_upgrade_status || "pending",
      choice: org.pack_upgrade_choice || "",
      amount: org.pack_upgrade_amount === null || org.pack_upgrade_amount === undefined ? null : Number(org.pack_upgrade_amount || 0),
      totalAfter: org.pack_upgrade_total_after === null || org.pack_upgrade_total_after === undefined ? null : Number(org.pack_upgrade_total_after || 0),
      unlimited: org.pack_upgrade_unlimited === true,
      requestedByEmail: org.pack_upgrade_requested_by_email || "",
      requestedAt: org.pack_upgrade_requested_at || null,
      sourceProjectId: org.pack_upgrade_source_project_id || null
    } : null,
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

function normalizeFrontendPath(path = "") {
  const cleanPath = String(path || "").trim() || "/";
  if (/^https?:\/\//i.test(cleanPath)) {
    try {
      const url = new URL(cleanPath);
      return `${url.pathname || "/"}${url.search || ""}${url.hash || ""}`;
    } catch (err) {
      return "/";
    }
  }

  return cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`;
}

function buildProtectedFrontendUrl(path = "") {
  const nextPath = normalizeFrontendPath(path);
  const encodedNext = encodeURIComponent(nextPath);
  return `${FRONTEND_URL}/login.html?next=${encodedNext}&redirect=${encodedNext}`;
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
    ADD COLUMN IF NOT EXISTS profile_photo_name TEXT;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS profile_photo_data_url TEXT;
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
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_alert_low_sent_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_alert_critical_sent_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_alert_empty_sent_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_expires_at DATE;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_expiry_alert_60_sent_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_expiry_alert_30_sent_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_expiry_alert_7_sent_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_expired_processed_at TIMESTAMP;
  `);


  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_upgrade_requested BOOLEAN DEFAULT false;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_upgrade_status TEXT;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_upgrade_choice TEXT;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_upgrade_amount INTEGER;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_upgrade_total_after INTEGER;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_upgrade_unlimited BOOLEAN DEFAULT false;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_upgrade_requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_upgrade_requested_by_email TEXT;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_upgrade_source_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_upgrade_requested_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_upgrade_email_sent_at TIMESTAMP;
  `);

  await pool.query(`
    ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS pack_upgrade_approved_email_sent_at TIMESTAMP;
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
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS publication_email_sent_at TIMESTAMP;
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


  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      audience TEXT NOT NULL DEFAULT 'client',
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      message TEXT,
      action_url TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      read_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications(user_id, read_at, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_notifications_org_unread
    ON notifications(organization_id, read_at, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_projects_updated_at
    ON projects(updated_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_projects_status_end_date
    ON projects(status, campaign_end_date);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_projects_organization_id
    ON projects(organization_id);
  `);


  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_communication_assets (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      data_url TEXT NOT NULL,
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS communication_assets_email_sent_at TIMESTAMP;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_catalogue_models (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      source_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      subject TEXT,
      audience TEXT,
      description TEXT,
      data JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_custom_catalogue_models_org
    ON custom_catalogue_models(organization_id, updated_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_custom_catalogue_models_user
    ON custom_catalogue_models(user_id, updated_at DESC);
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

function packIsActive(expiresAt) {
  const normalized = normalizeDateValue(expiresAt);
  if (!normalized) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = normalized.split('-').map(Number);
  const expiry = new Date(y, m - 1, d);
  return expiry.getTime() >= today.getTime();
}

function computeNextPackQuota({ currentQuota = 0, currentUsed = 0, amount = 0, expiresAt = null }) {
  const remaining = Math.max(0, Number(currentQuota || 0) - Number(currentUsed || 0));
  const safeAmount = Math.max(0, Number(amount || 0));
  return packIsActive(expiresAt) ? remaining + safeAmount : safeAmount;
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

function cleanProjectDisplayTitle(value = "") {
  const cleaned = String(value || "")
    .replace(/^\s*Autodiagnostic\s*[-–—:]?\s*/i, "")
    .replace(/^\s*Autodiag\s*[-–—:]?\s*/i, "")
    .trim();

  if (!cleaned || /^(mon projet|nouveau projet|mon premier customizer)$/i.test(cleaned)) {
    return "";
  }

  return cleaned;
}

function pickProjectDisplayTitle(...values) {
  for (const value of values) {
    const cleaned = cleanProjectDisplayTitle(value);
    if (cleaned) return cleaned;
  }
  return "Projet sans titre";
}

function extractProjectDisplayTitle(data = {}, fallbackTitle = "") {
  const d = data && typeof data === "object" ? data : {};
  const payload = d.payload && typeof d.payload === "object" ? d.payload : {};
  const state = d.state && typeof d.state === "object" ? d.state : {};
  const param = getProjectParamData(d);

  return pickProjectDisplayTitle(
    param.titre_repondants,
    param.titreRespondants,
    param.titre_visible_repondants,
    param.titreVisibleRepondants,
    param.titre_visible,
    param.titreVisible,
    param.titre,
    param.nom,
    payload.titre_repondants,
    payload.titreRespondants,
    payload.titre_autodiag,
    payload.autodiagTitle,
    payload.title,
    payload.titre,
    state.titre_repondants,
    state.titreRespondants,
    state.autodiagTitle,
    state.title,
    d.titre_repondants,
    d.titreRespondants,
    d.autodiagTitle,
    d.title,
    fallbackTitle
  );
}



function applyRespondentTitleToProjectData(data = {}, respondentTitle = "") {
  const safeData = data && typeof data === "object" && !Array.isArray(data) ? { ...data } : {};
  const title = String(respondentTitle || "").trim();

  const applyAliases = (target) => {
    if (!target || typeof target !== "object") return target;
    target.titre = title;
    target.titre_repondants = title;
    target.titreRespondants = title;
    target.titre_visible_repondants = title;
    target.titreVisibleRepondants = title;
    target.titre_visible = title;
    target.titreVisible = title;
    return target;
  };

  safeData.parametrage = applyAliases({ ...(safeData.parametrage && typeof safeData.parametrage === "object" ? safeData.parametrage : {}) });
  applyAliases(safeData);

  if (safeData.state && typeof safeData.state === "object") {
    safeData.state = { ...safeData.state };
    safeData.state.parametrage = applyAliases({ ...(safeData.state.parametrage && typeof safeData.state.parametrage === "object" ? safeData.state.parametrage : {}) });
    applyAliases(safeData.state);
  }

  if (safeData.payload && typeof safeData.payload === "object") {
    safeData.payload = { ...safeData.payload };
    safeData.payload.parametrage = applyAliases({ ...(safeData.payload.parametrage && typeof safeData.payload.parametrage === "object" ? safeData.payload.parametrage : {}) });
    applyAliases(safeData.payload);
  }

  safeData.respondent_title_updated_at = new Date().toISOString();
  safeData.respondentTitleUpdatedAt = safeData.respondent_title_updated_at;

  return safeData;
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

function getProjectPackUpgradeRequest(data = {}, organization = {}) {
  const d = data && typeof data === "object" ? data : {};
  const param = getProjectParamData(d);
  const packChoice = String(
    param.pack_choisi ||
    param.packChoisi ||
    param.selectedPack ||
    d.pack_choisi ||
    d.packChoisi ||
    d.selectedPack ||
    ""
  ).trim();

  const status = String(
    d.pack_upgrade_status ||
    d.packUpgradeStatus ||
    param.pack_upgrade_status ||
    param.packUpgradeStatus ||
    ""
  ).toLowerCase();

  if (!packChoice || packChoice === "current_pack" || packChoice === "existing") {
    return { requested: false, status: status || "", choice: packChoice };
  }

  if (status === "approved" || status === "rejected") {
    return {
      requested: true,
      status,
      choice: packChoice,
      amount: packChoice === "illimite" ? null : Number(packChoice || 0),
      unlimited: packChoice === "illimite"
    };
  }

  const organizationPack = String(
    organization.organization_passations_pack ||
    organization.passations_pack ||
    organization.passationsPack ||
    ""
  ).toLowerCase();

  const currentQuota = Number(
    organization.organization_passations_quota ??
    organization.passations_quota ??
    organization.passationsQuota ??
    0
  );

  const currentUsed = Number(
    organization.organization_passations_used ??
    organization.passations_used ??
    organization.passationsUsed ??
    0
  );

  const amount = packChoice === "illimite" ? null : Number(packChoice || 0);

  if (packChoice !== "illimite" && (!Number.isFinite(amount) || amount <= 0)) {
    return { requested: false, status: "", choice: packChoice };
  }

  if (organizationPack === "illimite" && packChoice !== "illimite") {
    return { requested: false, status: "not_required", choice: packChoice };
  }

  return {
    requested: true,
    status: "pending",
    choice: packChoice,
    amount,
    currentQuota,
    currentUsed,
    currentRemaining: organizationPack === "illimite" ? null : Math.max(0, currentQuota - currentUsed),
    totalAfter: packChoice === "illimite" ? null : currentQuota + amount,
    unlimited: packChoice === "illimite"
  };
}

function applyPackUpgradeMetadata(data = {}, request = {}, status = "pending") {
  const safeData = data && typeof data === "object" ? { ...data } : {};
  const param = safeData.parametrage && typeof safeData.parametrage === "object"
    ? { ...safeData.parametrage }
    : {};

  const metadata = {
    pack_upgrade_requested: request.requested === true,
    pack_upgrade_status: status,
    pack_upgrade_choice: request.choice || "",
    pack_upgrade_amount: request.unlimited ? null : (request.amount || null),
    pack_upgrade_total_after: request.unlimited ? null : (request.totalAfter || null),
    pack_upgrade_unlimited: request.unlimited === true,
    pack_upgrade_updated_at: new Date().toISOString()
  };

  return {
    ...safeData,
    ...metadata,
    packUpgradeRequested: metadata.pack_upgrade_requested,
    packUpgradeStatus: metadata.pack_upgrade_status,
    packUpgradeChoice: metadata.pack_upgrade_choice,
    packUpgradeAmount: metadata.pack_upgrade_amount,
    packUpgradeTotalAfter: metadata.pack_upgrade_total_after,
    packUpgradeUnlimited: metadata.pack_upgrade_unlimited,
    parametrage: {
      ...param,
      ...metadata,
      packUpgradeRequested: metadata.pack_upgrade_requested,
      packUpgradeStatus: metadata.pack_upgrade_status,
      packUpgradeChoice: metadata.pack_upgrade_choice,
      packUpgradeAmount: metadata.pack_upgrade_amount,
      packUpgradeTotalAfter: metadata.pack_upgrade_total_after,
      packUpgradeUnlimited: metadata.pack_upgrade_unlimited
    }
  };
}

function markPackExpiredAutoRepublishedMetadata(data = {}) {
  const safeData = data && typeof data === "object" ? { ...data } : {};
  delete safeData.packExpiredAutoUnpublished;
  delete safeData.pack_expired_auto_unpublished;
  delete safeData.packExpiredAutoUnpublishedAt;
  delete safeData.pack_expired_auto_unpublished_at;
  safeData.packExpiredAutoRepublished = true;
  safeData.pack_expired_auto_republished = true;
  safeData.packExpiredAutoRepublishedAt = new Date().toISOString();
  safeData.pack_expired_auto_republished_at = safeData.packExpiredAutoRepublishedAt;
  return safeData;
}


async function getOrganizationForPackUpgrade(organizationId) {
  if (!organizationId) return {};
  const result = await pool.query(
    `SELECT
       passations_pack,
       passations_quota,
       passations_used,
       passations_pack AS organization_passations_pack,
       passations_quota AS organization_passations_quota,
       passations_used AS organization_passations_used,
       pack_expires_at AS organization_pack_expires_at
     FROM organizations
     WHERE id = $1
     LIMIT 1`,
    [organizationId]
  );
  return result.rows[0] || {};
}

async function notifyPackUpgradeRequestIfNeeded(projectId) {
  if (!projectId || typeof sendPackUpgradeRequestEmail !== "function") return null;
  try {
    const result = await sendPackUpgradeRequestEmail(projectId);
    if (result?.sent) {
    }
    return result;
  } catch (err) {
    console.error("Erreur notification demande de devis pack", err);
    return { sent: false, reason: "SEND_FAILED" };
  }
}


async function persistOrganizationPackUpgradeRequest({ organizationId, userId = null, userEmail = '', sourceProjectId = null, request = {} }) {
  const orgId = Number(organizationId);
  if (!Number.isInteger(orgId) || orgId <= 0 || !request?.requested) return null;

  const choice = String(request.choice || '').trim();
  if (!choice || choice === 'current_pack' || choice === 'existing') return null;

  const amount = request.unlimited || choice === 'illimite' ? null : Number(request.amount || choice || 0);
  if (choice !== 'illimite' && (!Number.isFinite(amount) || amount <= 0)) return null;

  const result = await pool.query(
    `UPDATE organizations
     SET pack_upgrade_requested = true,
         pack_upgrade_status = 'pending',
         pack_upgrade_choice = $1,
         pack_upgrade_amount = $2,
         pack_upgrade_total_after = $3,
         pack_upgrade_unlimited = $4,
         pack_upgrade_requested_by = $5,
         pack_upgrade_requested_by_email = $6,
         pack_upgrade_source_project_id = $7,
         pack_upgrade_requested_at = NOW(),
         pack_upgrade_email_sent_at = NULL,
         pack_upgrade_approved_email_sent_at = NULL
     WHERE id = $8
     RETURNING *`,
    [
      choice,
      choice === 'illimite' ? null : amount,
      request.unlimited || choice === 'illimite' ? null : (request.totalAfter || null),
      request.unlimited === true || choice === 'illimite',
      userId || null,
      userEmail || '',
      sourceProjectId || null,
      orgId
    ]
  );

  return result.rows[0] || null;
}

function formatDateLongFr(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
}

function firstNonEmptyValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function extractProjectCommanditaire(data = {}) {
  const d = data && typeof data === "object" ? data : {};
  const payload = d.payload && typeof d.payload === "object" ? d.payload : {};
  const state = d.state && typeof d.state === "object" ? d.state : {};
  const param = getProjectParamData(d);
  const campaign = d.campagne || d.campaign || payload.campagne || payload.campaign || state.campagne || state.campaign || {};
  const communication = d.communication || payload.communication || state.communication || {};
  const clientInfo = d.clientInfo || d.client_info || payload.clientInfo || payload.client_info || state.clientInfo || state.client_info || {};
  const transmission = d.transmission && typeof d.transmission === "object" ? d.transmission : {};
  const transmissionPayload = transmission.payload && typeof transmission.payload === "object" ? transmission.payload : {};
  const transmissionClientInfo = transmission.clientInfo || transmission.client_info || transmissionPayload.clientInfo || transmissionPayload.client_info || {};

  const firstName = firstNonEmptyValue(
    campaign.commanditaireFirstName, campaign.commanditaire_first_name,
    campaign.contactFirstName, campaign.contact_first_name,
    param.commanditaireFirstName, param.commanditaire_first_name,
    param.contactFirstName, param.contact_first_name,
    clientInfo.firstName, clientInfo.first_name, clientInfo.prenom,
    transmissionClientInfo.firstName, transmissionClientInfo.first_name, transmissionClientInfo.prenom
  );
  const lastName = firstNonEmptyValue(
    campaign.commanditaireLastName, campaign.commanditaire_last_name,
    campaign.contactLastName, campaign.contact_last_name,
    param.commanditaireLastName, param.commanditaire_last_name,
    param.contactLastName, param.contact_last_name,
    clientInfo.lastName, clientInfo.last_name, clientInfo.nom,
    transmissionClientInfo.lastName, transmissionClientInfo.last_name, transmissionClientInfo.nom
  );

  const name = firstNonEmptyValue(
    campaign.commanditaireName, campaign.commanditaire_name,
    campaign.referentName, campaign.referent_name,
    campaign.contactName, campaign.contact_name,
    communication.commanditaireName, communication.commanditaire_name,
    communication.contactName, communication.contact_name,
    param.commanditaireName, param.commanditaire_name,
    param.referentName, param.referent_name,
    param.contactName, param.contact_name,
    clientInfo.name, clientInfo.fullName, clientInfo.full_name,
    transmissionClientInfo.name, transmissionClientInfo.fullName, transmissionClientInfo.full_name,
    [firstName, lastName].filter(Boolean).join(" ")
  );

  const email = firstNonEmptyValue(
    campaign.commanditaireEmail, campaign.commanditaire_email,
    campaign.referentEmail, campaign.referent_email,
    campaign.contactEmail, campaign.contact_email,
    communication.commanditaireEmail, communication.commanditaire_email,
    communication.contactEmail, communication.contact_email,
    param.commanditaireEmail, param.commanditaire_email,
    param.referentEmail, param.referent_email,
    param.contactEmail, param.contact_email,
    d.commanditaireEmail, d.commanditaire_email,
    payload.commanditaireEmail, payload.commanditaire_email,
    state.commanditaireEmail, state.commanditaire_email,
    clientInfo.email, clientInfo.mail,
    transmissionClientInfo.email, transmissionClientInfo.mail
  );

  return { name, email };
}

function normalizeEmail(value = "") {
  return String(value || "").trim().toLowerCase();
}


const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com",
  "outlook.com", "outlook.fr", "hotmail.com", "hotmail.fr", "live.com", "live.fr", "msn.com",
  "yahoo.com", "yahoo.fr", "ymail.com", "rocketmail.com",
  "icloud.com", "me.com", "mac.com",
  "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr", "neuf.fr", "bbox.fr", "laposte.net",
  "aol.com", "gmx.com", "gmx.fr", "mail.com", "mail.fr",
  "proton.me", "protonmail.com", "pm.me",
  "tutanota.com", "tuta.com", "zoho.com", "zohomail.com"
]);

function getEmailDomain(email = "") {
  const normalized = normalizeEmail(email);
  const parts = normalized.split("@");
  return parts.length === 2 ? parts[1] : "";
}

function isPersonalEmail(email = "") {
  const domain = getEmailDomain(email);
  return Boolean(domain && PERSONAL_EMAIL_DOMAINS.has(domain));
}

function uniqueEmails(...values) {
  const seen = new Set();
  const emails = [];
  for (const value of values.flat()) {
    const email = String(value || "").trim();
    const key = normalizeEmail(email);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }
  return emails;
}

function buildRecipientSet({ primary, cc = [] }) {
  const to = uniqueEmails(primary)[0] || "";
  const toKey = normalizeEmail(to);
  const ccList = uniqueEmails(cc).filter((email) => normalizeEmail(email) !== toKey);
  return {
    to,
    cc: ccList.join(",")
  };
}


async function getProjectForCommunicationAccess(projectId, user) {
  const result = await pool.query(
    `SELECT
       p.*,
       o.name AS organization_name,
       o.contact_name,
       o.contact_email,
       o.created_by AS organization_created_by,
       partner.email AS partner_email
     FROM projects p
     LEFT JOIN organizations o ON o.id = p.organization_id
     LEFT JOIN users partner ON partner.id = o.created_by AND partner.role = 'partner'
     WHERE p.id = $1
       AND (
         p.user_id = $2
         OR p.created_by = $2
         OR o.created_by = $2
         OR EXISTS (SELECT 1 FROM organization_users ou WHERE ou.organization_id = p.organization_id AND ou.user_id = $2)
         OR EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.role = 'admin')
       )
     LIMIT 1`,
    [projectId, user.id]
  );

  return result.rows[0] || null;
}

function formatCommunicationAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    fileName: row.file_name || '',
    file_name: row.file_name || '',
    mimeType: row.mime_type || '',
    mime_type: row.mime_type || '',
    sizeBytes: Number(row.size_bytes || 0),
    size_bytes: Number(row.size_bytes || 0),
    dataUrl: row.data_url || '',
    data_url: row.data_url || '',
    uploadedBy: row.uploaded_by || null,
    createdAt: row.created_at || null,
    created_at: row.created_at || null
  };
}

function isValidCommunicationAsset({ fileName, mimeType, dataUrl, sizeBytes }) {
  const allowedMime = ['application/pdf', 'image/png', 'image/jpeg'];
  const safeName = String(fileName || '').trim();
  const safeMime = String(mimeType || '').trim();
  const safeDataUrl = String(dataUrl || '').trim();
  const safeSize = Number(sizeBytes || 0);

  if (!safeName || safeName.length > 180) return false;
  if (!allowedMime.includes(safeMime)) return false;
  if (!safeDataUrl.startsWith(`data:${safeMime};base64,`)) return false;
  if (!Number.isFinite(safeSize) || safeSize <= 0 || safeSize > 4 * 1024 * 1024) return false;
  return true;
}

function getCommunicationRecipient(row) {
  const commanditaire = extractProjectCommanditaire(row.data || {});
  const ownerEmail = row.contact_email || row.user_email || '';
  const clientName =
    row.contact_name ||
    row.user_company_name ||
    `${row.user_first_name || ''} ${row.user_last_name || ''}`.trim() ||
    '';

  const recipients = buildRecipientSet({
    primary: ownerEmail || commanditaire.email,
    cc: []
  });

  return {
    to: recipients.to,
    cc: '',
    name: clientName || commanditaire.name,
    commanditaireName: commanditaire.name,
    commanditaireEmail: commanditaire.email,
    companyName: row.organization_name || row.user_company_name || '—'
  };
}
function buildCommunicationAssetsEmail({ row, recipient, assets }) {
  const title = extractProjectDisplayTitle(row.data || {}, row.title || 'votre autodiagnostic');
  const kitUrl = buildProtectedFrontendUrl(`/kit-communication.html?projectId=${encodeURIComponent(row.id)}`);
  const hello = recipient.name || '';

  return {
    subject: `Vos ressources de communication sont disponibles — ${title}`,
    text:
`Bonjour ${hello},

Les ressources de communication de votre autodiagnostic "${title}" sont maintenant disponibles.

Vous pouvez retrouver dans votre kit :
- QR code,
- affiches,
- visuels,
- messages prêts à diffuser,
- liens de campagne.

Accéder au kit de communication :
${kitUrl}

L’équipe Into The Shift`,
    html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55;background:#f3f6f8;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe8ef;border-radius:18px;padding:26px">
    <p>Bonjour ${escapeHtml(hello)},</p>
    <p>Les ressources de communication de votre autodiagnostic <strong>${escapeHtml(title)}</strong> sont maintenant disponibles.</p>
    <p>Vous pouvez retrouver dans votre kit :</p>
    <ul>
      <li>QR code,</li>
      <li>affiches,</li>
      <li>visuels,</li>
      <li>messages prêts à diffuser,</li>
      <li>liens de campagne.</li>
    </ul>
    <p style="margin:22px 0 10px"><a href="${escapeHtml(kitUrl)}" style="display:inline-block;background:#0d4c72;color:#ffffff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">Accéder au kit de communication</a></p>
    <p>L’équipe Into The Shift</p>
  </div>
</div>`
  };
}

async function sendCommunicationAssetsEmail(projectId) {
  const result = await pool.query(`
    SELECT
      p.id,
      p.title,
      p.data,
      p.organization_id,
      p.communication_assets_email_sent_at,
      o.name AS organization_name,
      o.contact_email,
      o.contact_name,
      client.email AS user_email,
      client.first_name AS user_first_name,
      client.last_name AS user_last_name,
      client.company_name AS user_company_name,
      partner.email AS partner_email
    FROM projects p
    LEFT JOIN users client ON client.id = p.user_id
    LEFT JOIN organizations o ON o.id = p.organization_id
    LEFT JOIN users partner ON partner.id = o.created_by AND partner.role = 'partner'
    WHERE p.id = $1
    LIMIT 1
  `, [projectId]);

  const row = result.rows[0];
  if (!row) return { sent: false, reason: 'PROJECT_NOT_FOUND' };

  const assetsResult = await pool.query(
    `SELECT file_name FROM project_communication_assets WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId]
  );

  if (!assetsResult.rows.length) return { sent: false, reason: 'NO_ASSETS' };

  const recipient = getCommunicationRecipient(row);
  if (!recipient.to) return { sent: false, reason: 'NO_RECIPIENT' };

  const mail = buildCommunicationAssetsEmail({ row, recipient, assets: assetsResult.rows });
  const mailResult = await sendTransactionalEmail({
    to: recipient.to,
    cc: recipient.cc || undefined,
    subject: mail.subject,
    text: mail.text,
    html: mail.html
  });

  if (mailResult.sent) {
    await pool.query(`UPDATE projects SET communication_assets_email_sent_at = NOW() WHERE id = $1`, [projectId]);
    await createClientNotificationForProject(projectId, {
      type: "communication_assets",
      title: "Ressources de communication disponibles",
      message: `Les ressources de communication de votre autodiagnostic « ${extractProjectDisplayTitle(row.data || {}, row.title || "votre autodiagnostic")} » sont maintenant disponibles.`,
      actionUrl: `/kit-communication.html?projectId=${encodeURIComponent(projectId)}`,
      metadata: { email: "communication_assets" }
    });
  }

  return {
    ...mailResult,
    to: recipient.to,
    cc: recipient.cc || ''
  };
}


function normalizeNotificationAudience(value = "client") {
  const audience = String(value || "client").toLowerCase();
  return ["admin", "client", "partner"].includes(audience) ? audience : "client";
}

function normalizeNotificationUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

async function createNotification({ audience = "client", userId = null, organizationId = null, projectId = null, type = "info", title = "Notification", message = "", actionUrl = "", metadata = {} } = {}) {
  try {
    const safeAudience = normalizeNotificationAudience(audience);
    const inputMetadata = metadata && typeof metadata === "object" ? metadata : {};
    let finalUserId = userId || inputMetadata.userId || inputMetadata.user_id || null;
    let finalOrganizationId = organizationId || inputMetadata.organizationId || inputMetadata.organization_id || null;
    const finalProjectId = projectId || inputMetadata.projectId || inputMetadata.project_id || null;

    // Sécurise les notifications liées à un AD : même si l'appelant ne transmet
    // que le projectId, on rattache toujours la notif au cockpit client concerné.
    // C'est indispensable pour que l'admin arrive sur client-folder?id=... et non
    // sur l'espace Mes AD du client.
    if (finalProjectId && (!finalUserId || !finalOrganizationId)) {
      const targetResult = await pool.query(
        `SELECT user_id, organization_id FROM projects WHERE id = $1 LIMIT 1`,
        [finalProjectId]
      );
      const target = targetResult.rows[0] || {};
      finalUserId = finalUserId || target.user_id || null;
      finalOrganizationId = finalOrganizationId || target.organization_id || null;
    }

    if (finalOrganizationId && !finalUserId) {
      const orgOwnerResult = await pool.query(
        `SELECT created_by FROM organizations WHERE id = $1 LIMIT 1`,
        [finalOrganizationId]
      );
      finalUserId = orgOwnerResult.rows[0]?.created_by || null;
    }

    const safeMetadata = metadata && typeof metadata === "object" ? { ...metadata } : {};
    if (finalProjectId && !safeMetadata.projectId) safeMetadata.projectId = finalProjectId;
    if (finalOrganizationId && !safeMetadata.organizationId) safeMetadata.organizationId = finalOrganizationId;
    if (finalUserId && !safeMetadata.userId) safeMetadata.userId = finalUserId;

    const finalType = String(type || "info");
    const finalActionUrl = safeAudience === "admin" && finalType === "brand_assets" && finalProjectId
      ? `/kit-communication.html?projectId=${encodeURIComponent(finalProjectId)}`
      : safeAudience === "admin" && finalOrganizationId
        ? `/client-folder.html?id=${encodeURIComponent(finalOrganizationId)}`
        : normalizeNotificationUrl(actionUrl);

    const result = await pool.query(
      `INSERT INTO notifications (audience, user_id, organization_id, project_id, type, title, message, action_url, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING *`,
      [
        safeAudience,
        finalUserId,
        finalOrganizationId,
        finalProjectId,
        finalType,
        String(title || "Notification"),
        String(message || ""),
        finalActionUrl,
        JSON.stringify(safeMetadata)
      ]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error("Erreur création notification", err);
    return null;
  }
}

async function createAdminNotificationForProject(projectId, payload = {}) {
  return createNotification({ audience: "admin", projectId, ...payload });
}

async function createClientNotificationForProject(projectId, payload = {}) {
  if (!projectId) return null;
  const result = await pool.query(
    `SELECT user_id, organization_id FROM projects WHERE id = $1 LIMIT 1`,
    [projectId]
  );
  const row = result.rows[0] || {};
  return createNotification({ audience: "client", userId: row.user_id || null, organizationId: row.organization_id || null, projectId, ...payload });
}

async function createClientNotificationForOrganization(organizationId, payload = {}) {
  if (!organizationId) return null;
  return createNotification({ audience: "client", organizationId, ...payload });
}

function isReprogrammedProjectData(data = {}) {
  const d = data && typeof data === "object" ? data : {};
  return (
    d.reprogrammed === true ||
    d.isReprogrammed === true ||
    d.campaign_reprogrammed === true ||
    d.campaignReprogrammed === true ||
    String(d.transmissionType || "").toLowerCase() === "reprogramming"
  );
}

function isExtendedProjectData(data = {}) {
  const d = data && typeof data === "object" ? data : {};
  return (
    d.extended === true ||
    d.isExtended === true ||
    d.campaign_extended === true ||
    d.campaignExtended === true ||
    String(d.transmissionType || "").toLowerCase() === "extension"
  );
}

function extensionValidationAlreadyNotified(data = {}) {
  const d = data && typeof data === "object" ? data : {};
  return Boolean(
    d.extensionValidatedNotifiedAt ||
    d.extension_validated_notified_at ||
    d.campaignExtensionValidatedAt ||
    d.campaign_extension_validated_at
  );
}

async function notifyClientExtensionValidatedIfNeeded(projectId, data = {}, source = "admin_publication") {
  if (!projectId || !isExtendedProjectData(data) || extensionValidationAlreadyNotified(data)) {
    return { sent: false, reason: "NOT_TRIGGERED" };
  }

  const notification = await createClientNotificationForProject(projectId, {
    type: "extended_validated",
    title: "Prolongation validée",
    message: "Votre demande de prolongation a été validée. La campagne prolongée est publiée.",
    actionUrl: `/kit-communication.html?projectId=${encodeURIComponent(projectId)}`,
    metadata: { source, email: "campaign_extension_validated" }
  });

  if (!notification) return { sent: false, reason: "NOT_CREATED" };

  await pool.query(
    `UPDATE projects
     SET data = COALESCE(data, '{}'::jsonb) || jsonb_build_object(
           'extensionValidatedNotifiedAt', NOW(),
           'extension_validated_notified_at', NOW(),
           'campaignExtensionValidatedAt', NOW(),
           'campaign_extension_validated_at', NOW()
         ),
         updated_at = NOW()
     WHERE id = $1`,
    [projectId]
  );

  return { sent: true, notificationId: notification.id || null };
}

async function getUserNotificationOrganizationIds(userId) {
  const result = await pool.query(
    `SELECT organization_id FROM organization_users WHERE user_id = $1
     UNION
     SELECT id AS organization_id FROM organizations WHERE created_by = $1`,
    [userId]
  );
  return result.rows.map(row => row.organization_id).filter(Boolean);
}

function formatNotification(row = {}) {
  return {
    id: row.id,
    audience: row.audience,
    userId: row.user_id || null,
    organizationId: row.organization_id || null,
    projectId: row.project_id || null,
    type: row.type || "info",
    title: row.title || "Notification",
    message: row.message || "",
    actionUrl: row.action_url || "",
    metadata: row.metadata || {},
    readAt: row.read_at || null,
    createdAt: row.created_at || null,
    unread: !row.read_at
  };
}

const campaignAlerts = createCampaignAlerts({ pool, sendTransactionalEmail, createNotification });
const { autoUnpublishExpiredProjects, processCampaignAlerts, runCampaignAlerts, sendProjectPublicationEmail, sendTransmissionEmails, sendExtensionEmails, sendReprogrammingEmails, sendCommunicationLinksUpdatedEmail, sendCommunicationVideoAvailableEmail, sendRespondentTitleUpdatedAdminAlert } = campaignAlerts;

const packAlerts = createPackAlerts({
  pool,
  sendTransactionalEmail,
  adminEmail: process.env.ALERT_ADMIN_EMAIL || "contact@intotheshift.io",
  createNotification
});
const { processPackAlerts, runPackAlerts, sendPackExpiryAlertForRow, sendPackAlertForOrganization, sendPackUpgradeRequestEmail, sendPackUpgradeApprovedEmail, sendAccountPackUpgradeRequestEmail, sendAccountPackUpgradeApprovedEmail, sendPackRepublishedAfterRechargeEmail } = packAlerts;

async function runOperationalAlerts() {
  const campaign = await runCampaignAlerts();
  const pack = await runPackAlerts();
  return {
    campaign,
    pack,
    totalSent: Number(campaign.totalSent || 0) + Number(pack.totalSent || 0),
    totalSkipped: Number(campaign.totalSkipped || 0) + Number(pack.totalSkipped || 0)
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
    version: "server-alert-emails-recipients-links-v15",
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
    hasAdminUserOrganizationTransfer: true,
    hasAdminOrganizationDelete: true,
    hasPackUpgradeValidation: true,
    hasCampaignAlertsModule: true,
    hasPackAlerts: true,
    hasImmediateManualPackAlerts: true,
    hasOperationalAlerts: true,
    hasNoPackUpgradeEmailFromProjectAutosave: true,
    hasCommunicationAssets: true,
    hasProjectCommanditaireEmails: true,
    hasCommunicationLinksNotify: true,
    hasPackUpgradeRequestEmail: true,
    hasPackUpgradeSeparateEmails: true,
    hasPackUpgradeApprovedEmail: true,
    hasTransmissionEmailTemplatesInCampaignAlerts: true,
    hasCampaignExtensionEmails: true,
    hasCampaignReprogrammingEmails: true,
    hasOrganizationUsersRoute: true,
    hasCustomCatalogueModels: true,
    smtpConfigured: mailerIsConfigured(),
    smtpHost: SMTP_HOST || null,
    smtpPort: SMTP_PORT || null,
    smtpSecure: SMTP_SECURE,
    frontendUrl: FRONTEND_URL
  });
});

app.post("/api/register", async (req, res) => {
  const { email, password, firstName, lastName, companyName, jobTitle, sector } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !password) {
    return res.status(400).json({ error: "Email et mot de passe requis" });
  }

  if (isPersonalEmail(normalizedEmail)) {
    return res.status(400).json({
      error: "Merci d’utiliser une adresse email professionnelle. Les adresses personnelles ne sont pas autorisées sur Into The Shift."
    });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, company_name, job_title, sector, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'client')
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, profile_photo_name, profile_photo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
      [normalizedEmail, passwordHash, firstName || "", lastName || "", companyName || "", jobTitle || "", sector || ""]
    );

    const user = userResult.rows[0];

    await ensureDirectClientOrganization(user.id);

    const loginUrl = buildProtectedFrontendUrl('/account.html');
    await sendTransactionalEmail({
      to: user.email,
      subject: "Bienvenue dans Shift Studio",
      text:
`Bonjour ${firstName || ""},

Votre compte Shift Studio a bien été créé.

Vous pouvez accéder à votre espace découverte ici :
${loginUrl}

Création gratuite + 15 passations offertes : les 15 passations sont offertes lors de la transmission de votre premier autodiagnostic à Into The Shift.

Aucun devis n’est envoyé tant que vous ne transmettez pas à Into The Shift une configuration pour diffusion.

Gestion des comptes : Les comptes n’ayant créé aucun autodiagnostic ou sans activité pendant plus de 90 jours pourront être supprimés automatiquement.

L’équipe Into The Shift`,
      html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.5;background:#f3f6f8;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe8ef;border-radius:18px;padding:26px">
    <p>Bonjour ${escapeHtml(firstName || "")},</p>
    <p>Votre compte <strong>Shift Studio</strong> a bien été créé.</p>
    <p><a href="${escapeHtml(loginUrl)}" style="display:inline-block;background:#0d4c72;color:#ffffff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Accéder à mon espace découverte</a></p>
    <div style="background:#fff7df;border:1px solid #ffc866;border-left:6px solid #ffc000;border-radius:12px;padding:14px;margin:18px 0">
      <p style="margin:0 0 8px"><strong>Création gratuite + 15 passations offertes</strong></p>
      <p style="margin:0">Les 15 passations sont offertes lors de la transmission de votre premier autodiagnostic à Into The Shift. Aucun devis n’est envoyé tant que vous ne transmettez pas une configuration pour diffusion.</p>
    </div>
    <div style="background:#eef6fb;border:1px solid #cbddea;border-left:6px solid #0d4c72;border-radius:12px;padding:14px;margin:18px 0">
      <p style="margin:0 0 8px"><strong>Compte professionnel uniquement</strong></p>
      <p style="margin:0">L’inscription est réservée aux adresses email professionnelles. Les adresses personnelles ne sont pas autorisées.</p>
      <p style="margin:8px 0 0">Les comptes n’ayant créé aucun autodiagnostic ou sans activité pendant plus de 90 jours pourront être supprimés automatiquement.</p>
    </div>
    <p>L’équipe Into The Shift</p>
  </div>
</div>`
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role || "client" },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token, user: formatUser(user), project: null });
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
    `SELECT id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, profile_photo_name, profile_photo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at
     FROM users
     WHERE id = $1`,
    [req.user.id]
  );

  res.json({ user: formatUser(result.rows[0]) });
});


app.get("/api/notifications", auth, async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
    const role = String(req.user.role || "client").toLowerCase();
    const orgIds = await getUserNotificationOrganizationIds(req.user.id);
    const params = [req.user.id, limit];
    let orgClause = "";

    if (orgIds.length) {
      params.push(orgIds);
      orgClause = `OR (n.audience IN ('client','partner') AND COALESCE(n.organization_id, p.organization_id) = ANY($3::int[]))`;
    }

    const adminClause = role === "admin" ? "OR n.audience = 'admin'" : "";
    const result = await pool.query(
      `SELECT
         n.*,
         COALESCE(n.user_id, p.user_id) AS user_id,
         COALESCE(n.organization_id, p.organization_id) AS organization_id
       FROM notifications n
       LEFT JOIN projects p ON p.id = n.project_id
       WHERE (n.audience IN ('client','partner') AND COALESCE(n.user_id, p.user_id) = $1)
          ${orgClause}
          ${adminClause}
       ORDER BY n.created_at DESC
       LIMIT $2`,
      params
    );

    const unread = result.rows.filter(row => !row.read_at).length;
    res.json({ notifications: result.rows.map(formatNotification), unread });
  } catch (err) {
    console.error("GET /api/notifications", err);
    res.status(500).json({ error: "Erreur chargement notifications." });
  }
});

app.patch("/api/notifications/:id/read", auth, async (req, res) => {
  try {
    const role = String(req.user.role || "client").toLowerCase();
    const orgIds = await getUserNotificationOrganizationIds(req.user.id);
    const params = [req.params.id, req.user.id];
    let orgClause = "";
    if (orgIds.length) {
      params.push(orgIds);
      orgClause = `OR (n.audience IN ('client','partner') AND COALESCE(n.organization_id, p.organization_id) = ANY($3::int[]))`;
    }
    const adminClause = role === "admin" ? "OR n.audience = 'admin'" : "";

    const result = await pool.query(
      `WITH allowed AS (
         SELECT n.id,
                COALESCE(n.user_id, p.user_id) AS resolved_user_id,
                COALESCE(n.organization_id, p.organization_id) AS resolved_organization_id
         FROM notifications n
         LEFT JOIN projects p ON p.id = n.project_id
         WHERE n.id = $1
           AND ((n.audience IN ('client','partner') AND COALESCE(n.user_id, p.user_id) = $2) ${orgClause} ${adminClause})
       )
       UPDATE notifications n
       SET read_at = COALESCE(n.read_at, NOW())
       FROM allowed a
       WHERE n.id = a.id
       RETURNING n.*,
         a.resolved_user_id AS user_id,
         a.resolved_organization_id AS organization_id`,
      params
    );

    if (!result.rows[0]) return res.status(404).json({ error: "Notification introuvable" });
    res.json({ notification: formatNotification(result.rows[0]) });
  } catch (err) {
    console.error("PATCH /api/notifications/:id/read", err);
    res.status(500).json({ error: "Erreur mise à jour notification." });
  }
});

app.patch("/api/notifications/read-all", auth, async (req, res) => {
  try {
    const role = String(req.user.role || "client").toLowerCase();
    const orgIds = await getUserNotificationOrganizationIds(req.user.id);
    const params = [req.user.id];
    let orgClause = "";
    if (orgIds.length) {
      params.push(orgIds);
      orgClause = `OR (n.audience IN ('client','partner') AND COALESCE(n.organization_id, p.organization_id) = ANY($2::int[]))`;
    }
    const adminClause = role === "admin" ? "OR n.audience = 'admin'" : "";

    const result = await pool.query(
      `WITH allowed AS (
         SELECT n.id
         FROM notifications n
         LEFT JOIN projects p ON p.id = n.project_id
         WHERE n.read_at IS NULL
           AND ((n.audience IN ('client','partner') AND COALESCE(n.user_id, p.user_id) = $1) ${orgClause} ${adminClause})
       )
       UPDATE notifications n
       SET read_at = COALESCE(n.read_at, NOW())
       FROM allowed a
       WHERE n.id = a.id
       RETURNING n.id`,
      params
    );

    res.json({ ok: true, updated: result.rowCount || 0 });
  } catch (err) {
    console.error("PATCH /api/notifications/read-all", err);
    res.status(500).json({ error: "Erreur mise à jour notifications." });
  }
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


app.post("/api/me/pack-upgrade-request", auth, async (req, res) => {
  const packChoice = String(req.body?.packChoice || req.body?.pack_choisi || "").trim();

  if (!packChoice || packChoice === "current_pack" || packChoice === "existing") {
    return res.status(400).json({ error: "Pack de recharge invalide." });
  }

  const amount = packChoice === "illimite" ? null : Number(packChoice || 0);
  if (packChoice !== "illimite" && (!Number.isFinite(amount) || amount <= 0)) {
    return res.status(400).json({ error: "Pack de recharge invalide." });
  }

  try {
    const organizationId = await getUserPrimaryOrganizationId(req.user.id);
    if (!organizationId) {
      return res.status(400).json({ error: "Aucun cockpit client n’est rattaché à ce compte." });
    }

    const orgForRequest = await getOrganizationForPackUpgrade(organizationId);
    if (String(orgForRequest.passations_pack || orgForRequest.organization_passations_pack || "").toLowerCase() === "illimite" && packChoice !== "illimite") {
      return res.status(400).json({ error: "Votre pack actuel est déjà illimité." });
    }

    await persistOrganizationPackUpgradeRequest({
      organizationId,
      userId: req.user.id,
      userEmail: req.user.email || "",
      sourceProjectId: null,
      request: {
        requested: true,
        status: "pending",
        choice: packChoice,
        amount,
        totalAfter: packChoice === "illimite" ? null : Number(orgForRequest.passations_quota || 0) + Number(amount || 0),
        unlimited: packChoice === "illimite"
      }
    });

    if (typeof sendAccountPackUpgradeRequestEmail !== "function") {
      return res.status(500).json({ error: "Alerte recharge indisponible." });
    }

    const result = await sendAccountPackUpgradeRequestEmail({
      organizationId,
      userId: req.user.id,
      packChoice
    });

    if (result?.reason === "NOT_REQUIRED_UNLIMITED_PACK") {
      return res.status(400).json({ error: "Votre pack actuel est déjà illimité." });
    }

    if (result?.reason === "ORGANIZATION_NOT_FOUND") {
      return res.status(404).json({ error: "Cockpit client introuvable." });
    }

    if (!result?.sent) {
      return res.status(500).json({ error: "Demande enregistrée mais email interne non envoyé.", emailStatus: result?.reason || "SEND_FAILED" });
    }

    res.json({
      ok: true,
      packChoice,
      emailSent: true,
      clientEmailSent: result.clientEmailSent === true,
      internalTo: result.internalTo || "",
      clientTo: result.clientTo || ""
    });
  } catch (err) {
    console.error("POST /api/me/pack-upgrade-request", err);
    res.status(500).json({ error: "Erreur demande de recharge pack." });
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
    profilePhotoName,
    profilePhotoDataUrl,
    passationLogoName,
    passationLogoDataUrl
  } = req.body;

  try {
    const currentResult = await pool.query(
      `SELECT id, email, first_name, last_name, company_name, job_title, sector,
              organization_logo_name, organization_logo_data_url,
              profile_photo_name, profile_photo_data_url,
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

    if (profilePhotoDataUrl !== undefined && profilePhotoDataUrl !== null && String(profilePhotoDataUrl || "")) {
      const photo = String(profilePhotoDataUrl || "");
      const validPrefix = photo.startsWith("data:image/png;base64,") || photo.startsWith("data:image/jpeg;base64,");
      const approxBytes = Math.ceil((photo.split(",")[1] || "").length * 3 / 4);
      if (!validPrefix || approxBytes > 500 * 1024) {
        return res.status(400).json({ error: "Photo de profil invalide ou trop lourde. JPG/PNG, 500 Ko maximum." });
      }
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
           profile_photo_name = $8,
           profile_photo_data_url = $9,
           passation_logo_name = $10,
           passation_logo_data_url = $11
       WHERE id = $12
       RETURNING id, email, first_name, last_name, company_name, job_title, sector,
                 organization_logo_name, organization_logo_data_url,
                 profile_photo_name, profile_photo_data_url,
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
        profilePhotoName !== undefined && profilePhotoName !== null ? profilePhotoName : current.profile_photo_name,
        profilePhotoDataUrl !== undefined && profilePhotoDataUrl !== null ? profilePhotoDataUrl : current.profile_photo_data_url,
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
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, profile_photo_name, profile_photo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
      [passwordHash, req.user.id]
    );

    res.json({ ok: true, user: formatUser(result.rows[0]) });
  } catch (err) {
    console.error("Erreur changement mot de passe", err);
    res.status(500).json({ error: "Erreur changement mot de passe" });
  }
});


function compactCustomModelData(data = {}) {
  const source = data && typeof data === "object" ? data : {};
  const clone = JSON.parse(JSON.stringify(source));
  delete clone.currentAdId;
  delete clone.project_id;
  delete clone.projectId;
  delete clone.share_url;
  delete clone.shareUrl;
  delete clone.results_url;
  delete clone.resultsUrl;
  delete clone.campaignStartDate;
  delete clone.campaign_start_date;
  delete clone.startDate;
  delete clone.start_date;
  delete clone.campaignEndDate;
  delete clone.campaign_end_date;
  delete clone.endDate;
  delete clone.end_date;
  delete clone.published_at;
  delete clone.publishedAt;
  delete clone.unpublished_at;
  delete clone.unpublishedAt;
  delete clone.archived_at;
  delete clone.archivedAt;
  delete clone.configTransmise;
  delete clone.config_transmise;
  delete clone.submitted;
  if (clone.parametrage && typeof clone.parametrage === "object") {
    delete clone.parametrage.date_lancement;
    delete clone.parametrage.dateLancement;
    delete clone.parametrage.date_cloture;
    delete clone.parametrage.dateCloture;
    delete clone.parametrage.pack_choisi;
    delete clone.parametrage.packChoisi;
    delete clone.parametrage.selectedPack;
    delete clone.parametrage.pack_upgrade_requested;
    delete clone.parametrage.packUpgradeRequested;
    delete clone.parametrage.pack_upgrade_status;
    delete clone.parametrage.packUpgradeStatus;
  }
  clone.mode = clone.mode || "blank";
  clone.source = "custom_model";
  clone.blankSetupDone = true;
  clone.status = "draft";
  clone.current_step = "questions";
  clone.step = "questions";
  delete clone.customModelId;
  delete clone.custom_model_id;
  delete clone.customModelSavedAt;
  delete clone.custom_model_saved_at;
  clone.savedAsCustomModel = false;
  clone.isCustomModel = false;
  return clone;
}

function extractCustomModelMeta(data = {}, body = {}) {
  const d = data && typeof data === "object" ? data : {};
  const custom = d.customModel && typeof d.customModel === "object" ? d.customModel : {};
  return {
    title: firstNonEmptyValue(body.title, custom.title, d.title, d.autodiagTitle, "Modèle personnalisé"),
    subject: firstNonEmptyValue(body.subject, custom.subject, d.subject, d.theme, "Personnalisé"),
    audience: firstNonEmptyValue(body.audience, custom.audience, d.audience, "Collaborateurs"),
    description: firstNonEmptyValue(body.description, custom.description, d.objective, d.description, "Modèle créé à partir d’une page vierge")
  };
}

function formatCustomCatalogueModel(row = {}) {
  return {
    id: row.id,
    organizationId: row.organization_id || null,
    userId: row.user_id || null,
    sourceProjectId: row.source_project_id || null,
    title: row.title || "Modèle personnalisé",
    subject: row.subject || "Personnalisé",
    audience: row.audience || "Collaborateurs",
    description: row.description || "",
    data: row.data || {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

app.get("/api/custom-models", auth, async (req, res) => {
  try {
    const orgIds = await getUserNotificationOrganizationIds(req.user.id);
    const params = [req.user.id];
    let orgClause = "";
    if (orgIds.length) {
      params.push(orgIds);
      orgClause = "OR organization_id = ANY($2::int[])";
    }
    const adminClause = String(req.user.role || "").toLowerCase() === "admin" ? "OR TRUE" : "";

    const result = await pool.query(
      `SELECT *
       FROM custom_catalogue_models
       WHERE user_id = $1
          ${orgClause}
          ${adminClause}
       ORDER BY updated_at DESC`,
      params
    );

    res.json({ models: result.rows.map(formatCustomCatalogueModel) });
  } catch (err) {
    console.error("GET /api/custom-models", err);
    res.status(500).json({ error: "Erreur chargement modèles personnalisés." });
  }
});

app.post("/api/custom-models", auth, async (req, res) => {
  try {
    const sourceProjectId = req.body?.projectId || req.body?.project_id || null;
    let data = req.body?.data && typeof req.body.data === "object" ? req.body.data : null;
    let organizationId = req.body?.organizationId || req.body?.organization_id || null;

    if (sourceProjectId) {
      const projectResult = await pool.query(
        `SELECT p.*
         FROM projects p
         LEFT JOIN organization_users ou ON ou.organization_id = p.organization_id AND ou.user_id = $2
         WHERE p.id = $1
           AND (
             p.user_id = $2
             OR p.created_by = $2
             OR ou.user_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.role = 'admin')
           )
         LIMIT 1`,
        [sourceProjectId, req.user.id]
      );
      const project = projectResult.rows[0];
      if (!project) return res.status(404).json({ error: "Projet source introuvable." });
      data = data || project.data || {};
      organizationId = organizationId || project.organization_id || null;
    }

    if (!data) return res.status(400).json({ error: "Données du modèle requises." });
    if (!organizationId) organizationId = await getUserPrimaryOrganizationId(req.user.id);

    const modelData = compactCustomModelData(data);
    const meta = extractCustomModelMeta(modelData, req.body || {});

    let result;
    let updated = false;

    if (sourceProjectId) {
      result = await pool.query(
        `UPDATE custom_catalogue_models
         SET title = $1,
             subject = $2,
             audience = $3,
             description = $4,
             data = $5::jsonb,
             updated_at = NOW()
         WHERE source_project_id = $6
           AND user_id = $7
           AND (organization_id IS NOT DISTINCT FROM $8)
         RETURNING *`,
        [
          meta.title,
          meta.subject,
          meta.audience,
          meta.description,
          JSON.stringify(modelData),
          sourceProjectId,
          req.user.id,
          organizationId || null
        ]
      );
      updated = Boolean(result.rows[0]);
    }

    if (!result || !result.rows[0]) {
      result = await pool.query(
        `INSERT INTO custom_catalogue_models (organization_id, user_id, source_project_id, title, subject, audience, description, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING *`,
        [
          organizationId || null,
          req.user.id,
          sourceProjectId || null,
          meta.title,
          meta.subject,
          meta.audience,
          meta.description,
          JSON.stringify(modelData)
        ]
      );
    }

    res.json({ model: formatCustomCatalogueModel(result.rows[0]), updated });
  } catch (err) {
    console.error("POST /api/custom-models", err);
    res.status(500).json({ error: "Erreur enregistrement modèle personnalisé." });
  }
});

app.post("/api/custom-models/:id/use", auth, async (req, res) => {
  try {
    const orgIds = await getUserNotificationOrganizationIds(req.user.id);
    const params = [req.params.id, req.user.id];
    let orgClause = "";
    if (orgIds.length) {
      params.push(orgIds);
      orgClause = "OR organization_id = ANY($3::int[])";
    }
    const adminClause = String(req.user.role || "").toLowerCase() === "admin" ? "OR TRUE" : "";

    const modelResult = await pool.query(
      `SELECT *
       FROM custom_catalogue_models
       WHERE id = $1
         AND (user_id = $2 ${orgClause} ${adminClause})
       LIMIT 1`,
      params
    );

    const model = modelResult.rows[0];
    if (!model) return res.status(404).json({ error: "Modèle personnalisé introuvable." });

    const newData = compactCustomModelData(model.data || {});
    const baseTitle = model.title || newData.title || "Autodiagnostic personnalisé";
    const projectTitle = `Copie de - ${baseTitle}`;
    newData.source = "custom_model";
    newData.customModelId = model.id;
    newData.custom_model_id = model.id;
    newData.sourceCustomModelTitle = baseTitle;
    newData.source_custom_model_title = baseTitle;
    newData.title = projectTitle;
    newData.subject = model.subject || newData.subject || "Personnalisé";
    newData.theme = model.subject || newData.theme || "Personnalisé";
    newData.audience = model.audience || newData.audience || "Collaborateurs";
    newData.objective = model.description || newData.objective || "";
    newData.parametrage = newData.parametrage && typeof newData.parametrage === "object" ? newData.parametrage : {};
    newData.parametrage.titre = projectTitle;
    newData.parametrage.titre_repondants = projectTitle;
    newData.parametrage.titreRespondants = projectTitle;
    newData.parametrage.titre_visible_repondants = projectTitle;
    newData.parametrage.titreVisibleRepondants = projectTitle;

    const result = await pool.query(
      `INSERT INTO projects (user_id, title, status, data, created_by, organization_id, current_step)
       VALUES ($1, $2, 'draft', $3::jsonb, $1, $4, 'questions')
       RETURNING *`,
      [req.user.id, projectTitle, JSON.stringify(newData), model.organization_id || null]
    );

    res.json({ project: result.rows[0] });
  } catch (err) {
    console.error("POST /api/custom-models/:id/use", err);
    res.status(500).json({ error: "Erreur création depuis le modèle personnalisé." });
  }
});

app.get("/api/projects", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT
       p.*,
       o.name AS organization_name,
       o.passations_pack AS organization_passations_pack,
       o.passations_quota AS organization_passations_quota,
       o.passations_used AS organization_passations_used,
         o.pack_expires_at AS organization_pack_expires_at
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
      const displayTitle = extractProjectDisplayTitle(data, row.title || "");
      return {
        ...row,
        title: displayTitle,
        displayTitle,
        organizationName: row.organization_name || "",
        organizationPassationsPack: row.organization_passations_pack || "",
        organizationPassationsQuota: Number(row.organization_passations_quota || 0),
        organizationPassationsUsed: Number(row.organization_passations_used || 0),
        organizationPassationsRemaining: Math.max(
          0,
          Number(row.organization_passations_quota || 0) -
          Number(row.organization_passations_used || 0)
        ),
        organizationPackExpiresAt: row.organization_pack_expires_at || null,
        organization_pack_expires_at: row.organization_pack_expires_at || null,
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
  const finalTitle = extractProjectDisplayTitle(data || {}, title || "");

  let normalizedData = data && typeof data === "object"
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

  const packUpgradeOrganization = await getOrganizationForPackUpgrade(finalOrganizationId);
  const packUpgradeRequest = getProjectPackUpgradeRequest(normalizedData || {}, packUpgradeOrganization || {});
  if (packUpgradeRequest.requested && packUpgradeRequest.status === "pending") {
    normalizedData = applyPackUpgradeMetadata(normalizedData || {}, packUpgradeRequest, "pending");
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
        finalTitle || null,
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
      if (packUpgradeRequest.requested && packUpgradeRequest.status === "pending") {
        await persistOrganizationPackUpgradeRequest({
          organizationId: finalOrganizationId,
          userId: req.user.id,
          userEmail: req.user.email || "",
          sourceProjectId: updateResult.rows[0].id,
          request: packUpgradeRequest
        });
      }
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
      finalTitle,
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

  if (packUpgradeRequest.requested && packUpgradeRequest.status === "pending") {
    await persistOrganizationPackUpgradeRequest({
      organizationId: finalOrganizationId,
      userId: req.user.id,
      userEmail: req.user.email || "",
      sourceProjectId: result.rows[0].id,
      request: packUpgradeRequest
    });
  }

  res.json({ project: result.rows[0] });
});

app.patch("/api/projects/:id/respondent-title", auth, async (req, res) => {
  const projectId = req.params.id;
  const respondentTitle = cleanProjectDisplayTitle(req.body?.title || req.body?.respondentTitle || req.body?.titre || "");

  if (!respondentTitle) {
    return res.status(400).json({ error: "Titre visible répondants requis" });
  }

  try {
    const currentResult = await pool.query(
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
      [projectId, req.user.id]
    );

    const currentProject = currentResult.rows[0];
    if (!currentProject) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const updatedData = applyRespondentTitleToProjectData(currentProject.data || {}, respondentTitle);

    const updateResult = await pool.query(
      `UPDATE projects
       SET title = $1,
           data = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [respondentTitle, updatedData, projectId]
    );

    const project = updateResult.rows[0];

    if (String(req.user.role || "").toLowerCase() !== "admin" && typeof sendRespondentTitleUpdatedAdminAlert === "function") {
      try {
        await sendRespondentTitleUpdatedAdminAlert(projectId, {
          previousTitle: extractProjectDisplayTitle(currentProject.data || {}, currentProject.title || ""),
          newTitle: respondentTitle,
          updatedBy: req.user.email || ""
        });
      } catch (alertErr) {
        console.error("Erreur alerte admin modification titre répondants", alertErr);
      }
    }

    res.json({
      ok: true,
      project: {
        ...project,
        title: respondentTitle,
        displayTitle: respondentTitle
      }
    });
  } catch (err) {
    console.error("Erreur modification titre répondants", err);
    res.status(500).json({ error: "Impossible de modifier le titre visible répondants" });
  }
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
         o.passations_used AS organization_passations_used,
         o.pack_expires_at AS organization_pack_expires_at,
         o.pack_upgrade_status AS organization_pack_upgrade_status
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

    const displayTitle = extractProjectDisplayTitle(data, row.title || "");

    res.json({
      project: {
        ...row,
        title: displayTitle,
        displayTitle,
        organizationName: row.organization_name || "",
        organizationPassationsPack: row.organization_passations_pack || "",
        organizationPassationsQuota: Number(row.organization_passations_quota || 0),
        organizationPassationsUsed: Number(row.organization_passations_used || 0),
        organizationPassationsRemaining: Math.max(
          0,
          Number(row.organization_passations_quota || 0) -
          Number(row.organization_passations_used || 0)
        ),
        organizationPackExpiresAt: row.organization_pack_expires_at || null,
        organization_pack_expires_at: row.organization_pack_expires_at || null,
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

  try {
    const result = await pool.query(
      `UPDATE projects
       SET status = 'unpublished',
           archived_at = NULL,
           updated_at = NOW()
       WHERE id = $1
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
      return res.status(404).json({ error: "Projet introuvable" });
    }

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

    const clonedData = JSON.parse(JSON.stringify(source.data || {}));

    function resetClonedProjectState(target) {
      if (!target || typeof target !== "object") return;

      target.isCopy = true;
      target.is_copy = true;
      target.clonedFromProjectId = source.id;
      target.cloned_from_project_id = source.id;
      target.copiedFromProjectId = source.id;
      target.copied_from_project_id = source.id;
      target.configTransmise = false;
      target.config_transmise = false;
      target.submitted = false;
      target.submitted_at = null;
      target.status = "draft";
      target.step = "questions";
      target.current_step = "questions";
      target.currentStep = "questions";
      target.shareUrl = "";
      target.share_url = "";
      target.resultsUrl = "";
      target.results_url = "";
      target.campaignStartDate = "";
      target.campaign_start_date = "";
      target.campaignEndDate = "";
      target.campaign_end_date = "";
      target.publishedAt = null;
      target.published_at = null;
      target.unpublishedAt = null;
      target.unpublished_at = null;
      target.archivedAt = null;
      target.archived_at = null;

      if (target.transmission && typeof target.transmission === "object") {
        target.transmission = {
          ...target.transmission,
          status: "draft",
          submitted_at: null,
          sent_at: null
        };
      }

      if (target.parametrage && typeof target.parametrage === "object") {
        target.parametrage.date_lancement = "";
        target.parametrage.dateLancement = "";
        target.parametrage.date_cloture = "";
        target.parametrage.dateCloture = "";
      }
    }

    resetClonedProjectState(clonedData);
    resetClonedProjectState(clonedData.state);
    resetClonedProjectState(clonedData.payload);

    const sourceTitle = extractProjectDisplayTitle(source.data || {}, source.title || "");
    const clonedTitle = `Copie de ${sourceTitle}`;
    clonedData.title = clonedTitle;
    clonedData.autodiagTitle = clonedTitle;
    if (clonedData.state && typeof clonedData.state === "object") {
      clonedData.state.title = clonedTitle;
      clonedData.state.autodiagTitle = clonedTitle;
    }
    if (clonedData.payload && typeof clonedData.payload === "object") {
      clonedData.payload.title = clonedTitle;
      clonedData.payload.autodiagTitle = clonedTitle;
    }

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
  const finalTitle = extractProjectDisplayTitle(data || {}, title || "");

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
      finalTitle || null,
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
      `SELECT id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, profile_photo_name, profile_photo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at
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
              'title', COALESCE(NULLIF(p.data->'parametrage'->>'titre_repondants', ''), NULLIF(p.data->'parametrage'->>'titreRespondants', ''), NULLIF(p.data->'parametrage'->>'titre_visible_repondants', ''), NULLIF(p.data->'parametrage'->>'titreVisibleRepondants', ''), NULLIF(p.data->'parametrage'->>'titre_visible', ''), NULLIF(p.data->'parametrage'->>'titreVisible', ''), NULLIF(p.data->'parametrage'->>'titre', ''), p.title),
              'displayTitle', COALESCE(NULLIF(p.data->'parametrage'->>'titre_repondants', ''), NULLIF(p.data->'parametrage'->>'titreRespondants', ''), NULLIF(p.data->'parametrage'->>'titre_visible_repondants', ''), NULLIF(p.data->'parametrage'->>'titreVisibleRepondants', ''), NULLIF(p.data->'parametrage'->>'titre_visible', ''), NULLIF(p.data->'parametrage'->>'titreVisible', ''), NULLIF(p.data->'parametrage'->>'titre', ''), p.title),
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


app.get("/api/admin/organizations/:id/users", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.email,
        u.first_name,
        u.last_name,
        u.company_name,
        u.job_title,
        u.role AS user_role,
        u.status,
        ou.role AS organization_role,
        ou.created_at AS attached_at
      FROM organization_users ou
      JOIN users u ON u.id = ou.user_id
      WHERE ou.organization_id = $1
      ORDER BY ou.created_at ASC, u.last_name ASC, u.first_name ASC, u.email ASC
    `, [id]);

    res.json({
      users: result.rows.map((row) => ({
        id: row.id,
        email: row.email || "",
        firstName: row.first_name || "",
        lastName: row.last_name || "",
        companyName: row.company_name || "",
        jobTitle: row.job_title || "",
        role: row.organization_role || "member",
        userRole: row.user_role || "client",
        status: row.status || "active",
        attachedAt: row.attached_at || null
      }))
    });
  } catch (err) {
    console.error("GET /api/admin/organizations/:id/users", err);
    res.status(500).json({ error: "Erreur chargement comptes rattachés." });
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
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, profile_photo_name, profile_photo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
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
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, profile_photo_name, profile_photo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
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
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, profile_photo_name, profile_photo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
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

    if (safeStatus === "deleted") {
      const deleted = await pool.query(
        `DELETE FROM users
         WHERE id = $1
         RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, profile_photo_name, profile_photo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
        [id]
      );

      return res.json({
        ok: true,
        hardDeleted: true,
        user: formatUser({ ...deleted.rows[0], status: "deleted" })
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET status = $1
       WHERE id = $2
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, profile_photo_name, profile_photo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
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
  const { passationsPack, passationsQuota, passationsUsed, packExpiresAt, pack_expires_at } = req.body;

  try {
    const result = await pool.query(
      `UPDATE organizations
       SET passations_pack = $1,
           passations_quota = $2,
           passations_used = $3,
           pack_expires_at = COALESCE($4::date, CASE WHEN COALESCE($2,0) > 0 OR COALESCE($1,'') <> '' THEN (CURRENT_DATE + INTERVAL '12 months')::date ELSE pack_expires_at END),
           pack_alert_low_sent_at = NULL,
           pack_alert_critical_sent_at = NULL,
           pack_alert_empty_sent_at = NULL,
           pack_expiry_alert_60_sent_at = NULL,
           pack_expiry_alert_30_sent_at = NULL,
           pack_expiry_alert_7_sent_at = NULL,
           pack_expired_processed_at = NULL
       WHERE id = $5
       RETURNING *`,
      [
        passationsPack || null,
        Number(passationsQuota || 0),
        Number(passationsUsed || 0),
        normalizeDateValue(packExpiresAt || pack_expires_at),
        id
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Organisation introuvable" });
    }

    let republishedProjects = [];
    const updatedOrganization = result.rows[0];
    const updatedPackIsActive = String(updatedOrganization.passations_pack || '').toLowerCase() === 'illimite' || (Number(updatedOrganization.passations_quota || 0) > 0 && packIsActive(updatedOrganization.pack_expires_at));
    if (updatedPackIsActive) {
      const republishedResult = await pool.query(
        `UPDATE projects
         SET status = 'published',
             published_at = COALESCE(published_at, NOW()),
             unpublished_at = NULL,
             data = (COALESCE(data, '{}'::jsonb)
                      - 'packExpiredAutoUnpublished'
                      - 'pack_expired_auto_unpublished'
                      - 'packExpiredAutoUnpublishedAt'
                      - 'pack_expired_auto_unpublished_at'
                      - 'packEmptyAutoUnpublished'
                      - 'pack_empty_auto_unpublished'
                      - 'packEmptyAutoUnpublishedAt'
                      - 'pack_empty_auto_unpublished_at'
                      - 'packAutoUnpublishedReason'
                      - 'pack_auto_unpublished_reason')
                    || jsonb_build_object(
                      'packExpiredAutoRepublished', true,
                      'pack_expired_auto_republished', true,
                      'packExpiredAutoRepublishedAt', NOW(),
                      'pack_expired_auto_republished_at', NOW()
                    ),
             updated_at = NOW()
         WHERE organization_id = $1
           AND status = 'unpublished'
           AND (
             COALESCE((data->>'packExpiredAutoUnpublished')::boolean, false) = true
             OR COALESCE((data->>'pack_expired_auto_unpublished')::boolean, false) = true
             OR COALESCE((data->>'packEmptyAutoUnpublished')::boolean, false) = true
             OR COALESCE((data->>'pack_empty_auto_unpublished')::boolean, false) = true
           )
         RETURNING id, title, share_url, results_url, campaign_start_date, campaign_end_date, data`,
        [id]
      );
      republishedProjects = republishedResult.rows || [];
    }

    let packRepublishedEmail = { sent: false, reason: "NO_REPUBLISHED_PROJECTS" };
    if (republishedProjects.length && typeof sendPackRepublishedAfterRechargeEmail === "function") {
      try {
        packRepublishedEmail = await sendPackRepublishedAfterRechargeEmail({ organizationId: id, projects: republishedProjects });
      } catch (emailErr) {
        console.error("Erreur notification campagnes republiées après recharge pack", emailErr);
        packRepublishedEmail = { sent: false, reason: "SEND_FAILED" };
      }
    }

    let packAlert = { sent: false, reason: "NOT_TRIGGERED" };
    let packExpiryAlert = { sent: false, reason: "NOT_TRIGGERED" };
    if (typeof sendPackAlertForOrganization === "function") {
      try {
        packAlert = await sendPackAlertForOrganization(id);
      } catch (alertErr) {
        console.error("Erreur alerte pack après mise à jour manuelle", alertErr);
        packAlert = { sent: false, reason: "SEND_FAILED" };
      }
    }
    if (typeof sendPackExpiryAlertForRow === "function") {
      try {
        packExpiryAlert = await sendPackExpiryAlertForRow(updatedOrganization, { mode: "all" });
      } catch (expiryErr) {
        console.error("Erreur alerte expiration pack après mise à jour manuelle", expiryErr);
        packExpiryAlert = { sent: false, reason: "SEND_FAILED" };
      }
    }

    res.json({
      organization: formatOrganization(result.rows[0]),
      packAlert,
      packExpiryAlert,
      packRepublishedEmail,
      republishedProjectsCount: republishedProjects.length
    });
  } catch (err) {
    console.error("Erreur mise à jour passations organisation", err);
    res.status(500).json({ error: "Erreur mise à jour passations client final" });
  }
});

app.delete("/api/admin/organizations/:id", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const organizationId = Number(id);

  if (!Number.isInteger(organizationId) || organizationId <= 0) {
    return res.status(400).json({ error: "ID organisation invalide" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const orgResult = await client.query(
      `SELECT *
       FROM organizations
       WHERE id = $1
       LIMIT 1
       FOR UPDATE`,
      [organizationId]
    );

    const organization = orgResult.rows[0];

    if (!organization) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Organisation introuvable" });
    }

    if (String(organization.type || "client").toLowerCase() !== "client") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Seuls les cockpits clients peuvent être supprimés depuis cette interface." });
    }

    const projectsResult = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM projects
       WHERE organization_id = $1`,
      [organizationId]
    );

    const usersResult = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM organization_users
       WHERE organization_id = $1`,
      [organizationId]
    );

    const projectsCount = Number(projectsResult.rows[0]?.count || 0);
    const usersCount = Number(usersResult.rows[0]?.count || 0);

    if (projectsCount > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Impossible de supprimer ce cockpit : des autodiagnostics y sont encore rattachés."
      });
    }

    if (usersCount > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Impossible de supprimer ce cockpit : des utilisateurs y sont encore rattachés."
      });
    }

    await client.query(
      `DELETE FROM organizations
       WHERE id = $1`,
      [organizationId]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      deletedOrganizationId: organizationId
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("DELETE /api/admin/organizations/:id", err);
    return res.status(500).json({ error: "Erreur suppression organisation" });
  } finally {
    client.release();
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
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, profile_photo_name, profile_photo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
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

    const loginUrl = buildProtectedFrontendUrl('/account.html?tab=securite&firstLogin=1');
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
  const { organizationId, role, transferProjects } = req.body;
  const userId = Number(id);
  const orgId = Number(organizationId);

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "ID utilisateur invalide" });
  }

  if (!Number.isInteger(orgId) || orgId <= 0) {
    return res.status(400).json({ error: "Organisation requise" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [userId]);
    const user = userResult.rows[0];
    if (!user) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    if (String(user.role || "client").toLowerCase() !== "client") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Seuls les comptes clients peuvent être rattachés à un cockpit client." });
    }

    const orgResult = await client.query(`SELECT * FROM organizations WHERE id = $1 LIMIT 1`, [orgId]);
    const org = orgResult.rows[0];
    if (!org) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Organisation introuvable" });
    }

    if (String(org.type || "client").toLowerCase() !== "client") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Le rattachement doit cibler un cockpit client." });
    }

    await client.query(
      `DELETE FROM organization_users
       WHERE user_id = $1
         AND organization_id <> $2`,
      [userId, orgId]
    );

    await client.query(
      `INSERT INTO organization_users (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id)
       DO UPDATE SET role = EXCLUDED.role`,
      [orgId, userId, role || "member"]
    );

    let transferredProjects = 0;

    if (transferProjects === true) {
      const moved = await client.query(
        `UPDATE projects
         SET organization_id = $1,
             updated_at = NOW()
         WHERE user_id = $2
            OR created_by = $2
         RETURNING id`,
        [orgId, userId]
      );
      transferredProjects = moved.rowCount || 0;
    }

    await client.query("COMMIT");

    res.json({ ok: true, organizationId: orgId, userId, transferredProjects });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /api/admin/users/:id/organization", err);
    res.status(500).json({ error: "Erreur rattachement utilisateur" });
  } finally {
    client.release();
  }
});

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
         o.pack_expires_at AS organization_pack_expires_at,
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
        title: extractProjectDisplayTitle(data, row.title || ""),
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
        organizationPackExpiresAt: row.organization_pack_expires_at || null,
        organization_pack_expires_at: row.organization_pack_expires_at || null,
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
         o.pack_expires_at AS organization_pack_expires_at,
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
    const currentResult = await pool.query(`SELECT status, data, publication_email_sent_at FROM projects WHERE id = $1 LIMIT 1`, [id]);
    if (!currentResult.rows[0]) {
      return res.status(404).json({ error: "Projet introuvable" });
    }
    const currentRow = currentResult.rows[0];
    const currentStatus = normalizeProjectStatusValue(currentRow.status);
    const isReprogrammingRepublication = isReprogrammedProjectData(currentRow.data || {}) && Boolean(currentRow.publication_email_sent_at);
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

    if (status === "unpublished" && currentStatus !== "unpublished") {
      await createClientNotificationForProject(id, {
        type: "unpublished",
        title: "Campagne dépubliée",
        message: "Votre campagne a été dépubliée par Into The Shift.",
        actionUrl: "/mes-autodiagnostics.html",
        metadata: { source: "admin_status", previousStatus: currentStatus }
      });
    }

    let publicationEmail = { sent: false, reason: "NOT_TRIGGERED" };
    if (status === "published" && currentStatus !== "published" && (currentStatus === "unpublished" || isReprogrammingRepublication)) {
      publicationEmail = await sendProjectPublicationEmail(id, { reprogramming: isReprogrammingRepublication });
    }

    let extensionValidationNotification = { sent: false, reason: "NOT_TRIGGERED" };
    if (status === "published") {
      extensionValidationNotification = await notifyClientExtensionValidatedIfNeeded(id, currentRow.data || {}, "admin_status");
    }

    res.json({
      ok: true,
      project: result.rows[0],
      extensionValidationNotification
    });
  } catch (err) {
    console.error("Erreur mise à jour statut projet admin", err);
    res.status(500).json({ error: "Erreur mise à jour statut projet" });
  }
});



app.patch("/api/admin/organizations/:id/pack-upgrade", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const action = String(req.body?.action || "").toLowerCase();

  if (!["approve", "reject"].includes(action)) {
    return res.status(400).json({ error: "Action invalide. Utilisez approve ou reject." });
  }

  const client = await pool.connect();
  let republishedProjects = [];

  try {
    await client.query("BEGIN");

    const orgResult = await client.query(`SELECT * FROM organizations WHERE id = $1 FOR UPDATE`, [id]);
    const org = orgResult.rows[0];
    if (!org) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Cockpit client introuvable." });
    }

    if (org.pack_upgrade_requested !== true || String(org.pack_upgrade_status || "").toLowerCase() !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Aucune recharge pack à valider pour ce cockpit client." });
    }

    const request = {
      requested: true,
      status: "pending",
      choice: org.pack_upgrade_choice || "",
      amount: org.pack_upgrade_amount,
      totalAfter: org.pack_upgrade_total_after,
      unlimited: org.pack_upgrade_unlimited === true
    };

    if (action === "reject") {
      const rejectedOrg = await client.query(
        `UPDATE organizations
         SET pack_upgrade_status = 'rejected'
         WHERE id = $1
         RETURNING *`,
        [id]
      );

      if (org.pack_upgrade_source_project_id) {
        const projectResult = await client.query(`SELECT * FROM projects WHERE id = $1 FOR UPDATE`, [org.pack_upgrade_source_project_id]);
        const project = projectResult.rows[0];
        if (project) {
          const rejectedData = applyPackUpgradeMetadata(project.data || {}, request, "rejected");
          await client.query(`UPDATE projects SET data = $1::jsonb, updated_at = NOW() WHERE id = $2`, [JSON.stringify(rejectedData), project.id]);
        }
      }

      await client.query("COMMIT");
      return res.json({ ok: true, status: "rejected", organization: formatOrganization(rejectedOrg.rows[0]) });
    }

    let updatedOrg;
    if (request.unlimited || String(request.choice || "") === "illimite") {
      updatedOrg = await client.query(
        `UPDATE organizations
         SET passations_pack = 'illimite',
             passations_quota = 0,
             passations_used = 0,
             pack_expires_at = (CURRENT_DATE + INTERVAL '12 months')::date,
             pack_expiry_alert_60_sent_at = NULL,
             pack_expiry_alert_30_sent_at = NULL,
             pack_expiry_alert_7_sent_at = NULL,
             pack_expired_processed_at = NULL,
             pack_upgrade_status = 'approved'
         WHERE id = $1
         RETURNING *`,
        [id]
      );
    } else {
      const amount = Number(request.amount || request.choice || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Montant de recharge invalide." });
      }

      const currentQuota = Number(org.passations_quota || 0);
      const currentUsed = Number(org.passations_used || 0);
      const nextQuota = computeNextPackQuota({ currentQuota, currentUsed, amount, expiresAt: org.pack_expires_at });
      updatedOrg = await client.query(
        `UPDATE organizations
         SET passations_pack = $1,
             passations_quota = $2,
             passations_used = 0,
             pack_expires_at = (CURRENT_DATE + INTERVAL '12 months')::date,
             pack_expiry_alert_60_sent_at = NULL,
             pack_expiry_alert_30_sent_at = NULL,
             pack_expiry_alert_7_sent_at = NULL,
             pack_expired_processed_at = NULL,
             pack_upgrade_status = 'approved',
             pack_upgrade_total_after = $2
         WHERE id = $3
         RETURNING *`,
        [String(nextQuota), nextQuota, id]
      );
    }


    const republishedResult = await client.query(
      `UPDATE projects
       SET status = 'published',
           published_at = COALESCE(published_at, NOW()),
           unpublished_at = NULL,
           data = (COALESCE(data, '{}'::jsonb)
                    - 'packExpiredAutoUnpublished'
                    - 'pack_expired_auto_unpublished'
                    - 'packExpiredAutoUnpublishedAt'
                    - 'pack_expired_auto_unpublished_at'
                    - 'packEmptyAutoUnpublished'
                    - 'pack_empty_auto_unpublished'
                    - 'packEmptyAutoUnpublishedAt'
                    - 'pack_empty_auto_unpublished_at'
                    - 'packAutoUnpublishedReason'
                    - 'pack_auto_unpublished_reason')
                  || jsonb_build_object(
                    'packExpiredAutoRepublished', true,
                    'pack_expired_auto_republished', true,
                    'packExpiredAutoRepublishedAt', NOW(),
                    'pack_expired_auto_republished_at', NOW()
                  ),
           updated_at = NOW()
       WHERE organization_id = $1
         AND status = 'unpublished'
         AND (
           COALESCE((data->>'packExpiredAutoUnpublished')::boolean, false) = true
           OR COALESCE((data->>'pack_expired_auto_unpublished')::boolean, false) = true
           OR COALESCE((data->>'packEmptyAutoUnpublished')::boolean, false) = true
           OR COALESCE((data->>'pack_empty_auto_unpublished')::boolean, false) = true
         )
       RETURNING id, title, share_url, results_url, campaign_start_date, campaign_end_date, data`,
      [id]
    );
    republishedProjects = republishedResult.rows || [];

    if (org.pack_upgrade_source_project_id) {
      const projectResult = await client.query(`SELECT * FROM projects WHERE id = $1 FOR UPDATE`, [org.pack_upgrade_source_project_id]);
      const project = projectResult.rows[0];
      if (project) {
        const approvedData = markPackExpiredAutoRepublishedMetadata(applyPackUpgradeMetadata(project.data || {}, request, "approved"));
        await client.query(`UPDATE projects SET data = $1::jsonb, updated_at = NOW() WHERE id = $2`, [JSON.stringify(approvedData), project.id]);
      }
    }

    await client.query("COMMIT");

    let packUpgradeApprovedEmail = { sent: false, reason: "NOT_TRIGGERED" };
    if (typeof sendAccountPackUpgradeApprovedEmail === "function") {
      try {
        packUpgradeApprovedEmail = await sendAccountPackUpgradeApprovedEmail(id);
      } catch (emailErr) {
        console.error("Erreur notification recharge pack validée", emailErr);
        packUpgradeApprovedEmail = { sent: false, reason: "SEND_FAILED" };
      }
    }

    let packRepublishedEmail = { sent: false, reason: "NO_REPUBLISHED_PROJECTS" };
    if (republishedProjects.length && typeof sendPackRepublishedAfterRechargeEmail === "function") {
      try {
        packRepublishedEmail = await sendPackRepublishedAfterRechargeEmail({ organizationId: id, projects: republishedProjects });
      } catch (emailErr) {
        console.error("Erreur notification campagnes republiées après recharge pack", emailErr);
        packRepublishedEmail = { sent: false, reason: "SEND_FAILED" };
      }
    }

    return res.json({
      ok: true,
      status: "approved",
      organization: formatOrganization(updatedOrg.rows[0]),
      packUpgradeApprovedEmail,
      packRepublishedEmail,
      republishedProjectsCount: republishedProjects.length
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /api/admin/organizations/:id/pack-upgrade", err);
    res.status(500).json({ error: "Erreur validation recharge pack.", detail: err.message || "" });
  } finally {
    client.release();
  }
});

app.patch("/api/admin/projects/:id/pack-upgrade", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const action = String(req.body?.action || "").toLowerCase();

  if (!["approve", "reject"].includes(action)) {
    return res.status(400).json({ error: "Action invalide. Utilisez approve ou reject." });
  }

  const client = await pool.connect();
  let republishedProjects = [];
  let republishedOrganizationId = null;

  try {
    await client.query("BEGIN");

    const projectResult = await client.query(
      `SELECT
         p.*,
         o.passations_pack AS organization_passations_pack,
         o.passations_quota AS organization_passations_quota,
         o.passations_used AS organization_passations_used,
         o.pack_expires_at AS organization_pack_expires_at,
         o.pack_upgrade_status AS organization_pack_upgrade_status
       FROM projects p
       LEFT JOIN organizations o ON o.id = p.organization_id
       WHERE p.id = $1
       FOR UPDATE OF p`,
      [id]
    );

    const project = projectResult.rows[0];
    if (!project) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Projet introuvable" });
    }

    if (!project.organization_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Aucun cockpit client n’est rattaché à ce projet." });
    }

    const request = getProjectPackUpgradeRequest(project.data || {}, project);

    if (!request.requested) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Aucune recharge pack à valider pour ce projet." });
    }

    if (request.status === "approved" && action === "approve") {
      await client.query("COMMIT");
      return res.json({ ok: true, alreadyApproved: true, packUpgrade: request });
    }

    if (action === "reject") {
      const rejectedData = applyPackUpgradeMetadata(project.data || {}, request, "rejected");
      const updatedProject = await client.query(
        `UPDATE projects
         SET data = $1::jsonb,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [JSON.stringify(rejectedData), id]
      );

      await client.query("COMMIT");
      return res.json({ ok: true, status: "rejected", project: updatedProject.rows[0] });
    }

    const orgResult = await client.query(
      `SELECT * FROM organizations WHERE id = $1 FOR UPDATE`,
      [project.organization_id]
    );

    const org = orgResult.rows[0];
    if (!org) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Cockpit client introuvable." });
    }

    const approvedData = markPackExpiredAutoRepublishedMetadata(applyPackUpgradeMetadata(project.data || {}, request, "approved"));

    let updatedOrg;
    if (request.unlimited) {
      updatedOrg = await client.query(
        `UPDATE organizations
         SET passations_pack = 'illimite',
             passations_quota = 0,
             passations_used = 0,
             pack_expires_at = (CURRENT_DATE + INTERVAL '12 months')::date,
             pack_expiry_alert_60_sent_at = NULL,
             pack_expiry_alert_30_sent_at = NULL,
             pack_expiry_alert_7_sent_at = NULL,
             pack_expired_processed_at = NULL
         WHERE id = $1
         RETURNING *`,
        [project.organization_id]
      );
    } else {
      const amount = Number(request.amount || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Montant de recharge invalide." });
      }

      const currentQuota = Number(org.passations_quota || 0);
      const currentUsed = Number(org.passations_used || 0);
      const nextQuota = computeNextPackQuota({ currentQuota, currentUsed, amount, expiresAt: org.pack_expires_at });

      updatedOrg = await client.query(
        `UPDATE organizations
         SET passations_pack = $1,
             passations_quota = $2,
             passations_used = 0,
             pack_expires_at = (CURRENT_DATE + INTERVAL '12 months')::date,
             pack_expiry_alert_60_sent_at = NULL,
             pack_expiry_alert_30_sent_at = NULL,
             pack_expiry_alert_7_sent_at = NULL,
             pack_expired_processed_at = NULL
         WHERE id = $3
         RETURNING *`,
        [String(nextQuota), nextQuota, project.organization_id]
      );
    }


    republishedOrganizationId = project.organization_id;
    const republishedResult = await client.query(
      `UPDATE projects
       SET status = 'published',
           published_at = COALESCE(published_at, NOW()),
           unpublished_at = NULL,
           data = (COALESCE(data, '{}'::jsonb)
                    - 'packExpiredAutoUnpublished'
                    - 'pack_expired_auto_unpublished'
                    - 'packExpiredAutoUnpublishedAt'
                    - 'pack_expired_auto_unpublished_at'
                    - 'packEmptyAutoUnpublished'
                    - 'pack_empty_auto_unpublished'
                    - 'packEmptyAutoUnpublishedAt'
                    - 'pack_empty_auto_unpublished_at'
                    - 'packAutoUnpublishedReason'
                    - 'pack_auto_unpublished_reason')
                  || jsonb_build_object(
                    'packExpiredAutoRepublished', true,
                    'pack_expired_auto_republished', true,
                    'packExpiredAutoRepublishedAt', NOW(),
                    'pack_expired_auto_republished_at', NOW()
                  ),
           updated_at = NOW()
       WHERE organization_id = $1
         AND status = 'unpublished'
         AND (
           COALESCE((data->>'packExpiredAutoUnpublished')::boolean, false) = true
           OR COALESCE((data->>'pack_expired_auto_unpublished')::boolean, false) = true
           OR COALESCE((data->>'packEmptyAutoUnpublished')::boolean, false) = true
           OR COALESCE((data->>'pack_empty_auto_unpublished')::boolean, false) = true
         )
       RETURNING id, title, share_url, results_url, campaign_start_date, campaign_end_date, data`,
      [project.organization_id]
    );
    republishedProjects = republishedResult.rows || [];

    const updatedProject = await client.query(
      `UPDATE projects
       SET data = $1::jsonb,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(approvedData), id]
    );

    await client.query("COMMIT");

    let packUpgradeApprovedEmail = { sent: false, reason: "NOT_TRIGGERED" };
    if (typeof sendPackUpgradeApprovedEmail === "function") {
      try {
        packUpgradeApprovedEmail = await sendPackUpgradeApprovedEmail(id);
      } catch (emailErr) {
        console.error("Erreur notification recharge pack validée", emailErr);
        packUpgradeApprovedEmail = { sent: false, reason: "SEND_FAILED" };
      }
    }

    let packRepublishedEmail = { sent: false, reason: "NO_REPUBLISHED_PROJECTS" };
    if (republishedProjects.length && republishedOrganizationId && typeof sendPackRepublishedAfterRechargeEmail === "function") {
      try {
        packRepublishedEmail = await sendPackRepublishedAfterRechargeEmail({ organizationId: republishedOrganizationId, projects: republishedProjects });
      } catch (emailErr) {
        console.error("Erreur notification campagnes republiées après recharge pack", emailErr);
        packRepublishedEmail = { sent: false, reason: "SEND_FAILED" };
      }
    }

    return res.json({
      ok: true,
      status: "approved",
      project: updatedProject.rows[0],
      organization: formatOrganization(updatedOrg.rows[0]),
      packUpgradeApprovedEmail,
      packRepublishedEmail,
      republishedProjectsCount: republishedProjects.length
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /api/admin/projects/:id/pack-upgrade", err);
    res.status(500).json({ error: "Erreur validation recharge pack.", detail: err.message || "" });
  } finally {
    client.release();
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
      `SELECT
         p.status,
         p.share_url,
         p.results_url,
         p.data,
         p.organization_id,
         p.publication_email_sent_at,
         o.passations_pack AS organization_passations_pack,
         o.passations_quota AS organization_passations_quota,
         o.passations_used AS organization_passations_used,
         o.pack_expires_at AS organization_pack_expires_at,
         o.pack_upgrade_status AS organization_pack_upgrade_status
       FROM projects p
       LEFT JOIN organizations o ON o.id = p.organization_id
       WHERE p.id = $1
       LIMIT 1`,
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

    if (finalStatus === "published") {
      const packRequest = getProjectPackUpgradeRequest(existing.data || {}, existing);
      const organizationUpgradeStatus = String(
        existing.organization_pack_upgrade_status || ""
      ).toLowerCase();

      const hasApprovedUpgrade =
        packRequest.status === "approved" ||
        organizationUpgradeStatus === "approved";

      if (
        packRequest.requested &&
        packRequest.status === "pending" &&
        !hasApprovedUpgrade
      ) {
        return res.status(409).json({
          error: "Recharge pack à valider avant publication.",
          code: "PACK_UPGRADE_PENDING",
          packUpgrade: packRequest
        });
      }

      const organizationPack = String(existing.organization_passations_pack || "").toLowerCase();
      const quota = Number(existing.organization_passations_quota || 0);
      const used = Number(existing.organization_passations_used || 0);
      const remaining = organizationPack === "illimite" ? Infinity : Math.max(0, quota - used);

      if (!existing.organization_id) {
        return res.status(400).json({ error: "Aucun cockpit client n’est rattaché à ce projet." });
      }

      if (organizationPack !== "illimite" && remaining <= 0) {
        return res.status(409).json({
          error: "Pack épuisé : validez une recharge ou modifiez le quota avant publication.",
          code: "NO_PASSATIONS_REMAINING",
          passationsRemaining: 0
        });
      }
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

    let publicationEmail = { sent: false, reason: "NOT_TRIGGERED" };
    if (finalStatus === "published" && currentStatus !== "published" && !existing.publication_email_sent_at) {
      publicationEmail = await sendProjectPublicationEmail(id, { reprogramming: false });
    }

    let statusNotification = { sent: false, reason: "NOT_TRIGGERED" };
    if (finalStatus === "unpublished" && currentStatus !== "unpublished") {
      statusNotification = await createClientNotificationForProject(id, {
        type: "unpublished",
        title: "Campagne dépubliée",
        message: "Votre campagne a été dépubliée par Into The Shift.",
        actionUrl: "/mes-autodiagnostics.html",
        metadata: { source: "admin_publication", previousStatus: currentStatus }
      }) || { sent: false, reason: "NOT_CREATED" };
    }

    const isReprogrammingRepublication = isReprogrammedProjectData(existing.data || {}) && Boolean(existing.publication_email_sent_at);
    if (finalStatus === "published" && currentStatus !== "published" && existing.publication_email_sent_at && (currentStatus === "unpublished" || isReprogrammingRepublication)) {
      publicationEmail = await sendProjectPublicationEmail(id, { reprogramming: isReprogrammingRepublication });
      statusNotification = publicationEmail.sent
        ? { sent: true, source: "publication_email" }
        : { sent: false, reason: publicationEmail.reason || "EMAIL_NOT_SENT" };
    }

    let extensionValidationNotification = { sent: false, reason: "NOT_TRIGGERED" };
    if (finalStatus === "published") {
      extensionValidationNotification = await notifyClientExtensionValidatedIfNeeded(id, existing.data || {}, "admin_publication");
      if (extensionValidationNotification.sent) {
        statusNotification = extensionValidationNotification;
      }
    }

    let communicationLinksNotification = { sent: false, reason: "NOT_TRIGGERED" };
    const shareUrlChanged = Boolean(existing.share_url) && nextShareUrl && nextShareUrl !== existing.share_url;
    const resultsUrlChanged = Boolean(existing.results_url) && nextResultsUrl && nextResultsUrl !== existing.results_url;
    if ((shareUrlChanged || resultsUrlChanged) && typeof sendCommunicationLinksUpdatedEmail === "function") {
      try {
        communicationLinksNotification = await sendCommunicationLinksUpdatedEmail(id, {
          previousShareUrl: existing.share_url || "",
          previousResultsUrl: existing.results_url || "",
          newShareUrl: nextShareUrl || "",
          newResultsUrl: nextResultsUrl || ""
        });
      } catch (linksErr) {
        console.error("Erreur notification liens de communication", linksErr);
        communicationLinksNotification = { sent: false, reason: "SEND_FAILED" };
      }
    }

    res.json({ ok: true, project: result.rows[0], publicationEmail, statusNotification, extensionValidationNotification, communicationLinksNotification });
  } catch (err) {
    console.error("Erreur publication projet", err);
    res.status(500).json({ error: "Erreur publication projet" });
  }
});

app.get("/api/projects/:id/communication-assets", auth, async (req, res) => {
  const { id } = req.params;

  try {
    const project = await getProjectForCommunicationAccess(id, req.user);
    if (!project) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const result = await pool.query(
      `SELECT *
       FROM project_communication_assets
       WHERE project_id = $1
       ORDER BY created_at DESC`,
      [id]
    );

    res.json({ assets: result.rows.map(formatCommunicationAsset) });
  } catch (err) {
    console.error("GET /api/projects/:id/communication-assets", err);
    res.status(500).json({ error: "Erreur chargement ressources de communication." });
  }
});

app.post("/api/admin/projects/:id/communication-assets", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const fileName = String(req.body?.fileName || req.body?.file_name || "").trim();
  const mimeType = String(req.body?.mimeType || req.body?.mime_type || "").trim();
  const dataUrl = String(req.body?.dataUrl || req.body?.data_url || "").trim();
  const sizeBytes = Number(req.body?.sizeBytes || req.body?.size_bytes || 0);

  if (!isValidCommunicationAsset({ fileName, mimeType, dataUrl, sizeBytes })) {
    return res.status(400).json({ error: "Fichier invalide. Formats acceptés : PDF, PNG, JPG, 4 Mo maximum." });
  }

  try {
    const project = await getProjectForCommunicationAccess(id, req.user);
    if (!project) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const result = await pool.query(
      `INSERT INTO project_communication_assets (project_id, file_name, mime_type, size_bytes, data_url, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id, fileName, mimeType, sizeBytes, dataUrl, req.user.id]
    );

    await pool.query(`UPDATE projects SET updated_at = NOW() WHERE id = $1`, [id]);

    res.json({ ok: true, asset: formatCommunicationAsset(result.rows[0]) });
  } catch (err) {
    console.error("POST /api/admin/projects/:id/communication-assets", err);
    res.status(500).json({ error: "Erreur ajout ressource de communication." });
  }
});

// Dépôt CLIENT (logo / charte graphique) sur le kit de communication.
// Distinct de la route admin : accès via getProjectForCommunicationAccess (autorise
// le client rattaché au projet), et le nom de fichier est préfixé "charte-logo-client__"
// pour être reconnu comme élément de marque côté kit (isBrandAsset).
app.post("/api/projects/:id/communication-assets", auth, async (req, res) => {
  const { id } = req.params;
  const rawName = String(req.body?.fileName || req.body?.file_name || "").trim();
  const mimeType = String(req.body?.mimeType || req.body?.mime_type || "").trim();
  const dataUrl = String(req.body?.dataUrl || req.body?.data_url || "").trim();
  const sizeBytes = Number(req.body?.sizeBytes || req.body?.size_bytes || 0);
  const fileName = rawName.startsWith("charte-logo-client__") ? rawName : `charte-logo-client__${rawName}`;

  if (!isValidCommunicationAsset({ fileName, mimeType, dataUrl, sizeBytes })) {
    return res.status(400).json({ error: "Fichier invalide. Formats acceptés : PDF, PNG, JPG, 4 Mo maximum." });
  }

  try {
    const project = await getProjectForCommunicationAccess(id, req.user);
    if (!project) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const result = await pool.query(
      `INSERT INTO project_communication_assets (project_id, file_name, mime_type, size_bytes, data_url, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id, fileName, mimeType, sizeBytes, dataUrl, req.user.id]
    );

    await pool.query(`UPDATE projects SET updated_at = NOW() WHERE id = $1`, [id]);

    // Alerte admin : le client a déposé un élément de marque à récupérer.
    await createNotification({
      audience: "admin",
      organizationId: project.organization_id || null,
      projectId: project.id || id,
      type: "brand_assets",
      title: "Logo / charte déposés par le client",
      message: `Le client « ${project.organization_name || project.contact_name || "client"} » a déposé un élément de marque sur le kit de communication.`,
      actionUrl: `/kit-communication.html?projectId=${encodeURIComponent(project.id || id)}`,
      metadata: { source: "kit_communication", fileName, projectId: project.id || id, organizationId: project.organization_id || null }
    });

    res.json({ ok: true, asset: formatCommunicationAsset(result.rows[0]) });
  } catch (err) {
    console.error("POST /api/projects/:id/communication-assets", err);
    res.status(500).json({ error: "Erreur ajout ressource de communication." });
  }
});

app.delete("/api/admin/communication-assets/:assetId", auth, requireAdmin, async (req, res) => {
  const { assetId } = req.params;

  try {
    const existing = await pool.query(
      `SELECT project_id FROM project_communication_assets WHERE id = $1 LIMIT 1`,
      [assetId]
    );

    if (!existing.rows[0]) {
      return res.status(404).json({ error: "Ressource introuvable" });
    }

    await pool.query(`DELETE FROM project_communication_assets WHERE id = $1`, [assetId]);
    await pool.query(`UPDATE projects SET updated_at = NOW() WHERE id = $1`, [existing.rows[0].project_id]);

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/admin/communication-assets/:assetId", err);
    res.status(500).json({ error: "Erreur suppression ressource de communication." });
  }
});

app.delete("/api/projects/:projectId/communication-assets/:assetId", auth, async (req, res) => {
  const { projectId, assetId } = req.params;

  try {
    const project = await getProjectForCommunicationAccess(projectId, req.user);
    if (!project) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const existing = await pool.query(
      `SELECT project_id
       FROM project_communication_assets
       WHERE id = $1
         AND project_id = $2
       LIMIT 1`,
      [assetId, projectId]
    );

    if (!existing.rows[0]) {
      return res.status(404).json({ error: "Ressource introuvable" });
    }

    await pool.query(
      `DELETE FROM project_communication_assets
       WHERE id = $1`,
      [assetId]
    );

    await pool.query(
      `UPDATE projects
       SET updated_at = NOW()
       WHERE id = $1`,
      [projectId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/projects/:projectId/communication-assets/:assetId", err);
    res.status(500).json({ error: "Erreur suppression ressource de communication." });
  }
});



app.patch("/api/projects/:id/communication-notes", auth, async (req, res) => {
  const { id } = req.params;
  const clientBrandComment = String(req.body?.clientBrandComment || req.body?.client_brand_comment || "").trim();
  const adminDeliveryComment = String(req.body?.adminDeliveryComment || req.body?.admin_delivery_comment || "").trim();
  const isAdminUser = String(req.user?.role || "").toLowerCase() === "admin";

  if (clientBrandComment.length > 1200) {
    return res.status(400).json({ error: "Commentaire client trop long. 1200 caractères maximum." });
  }

  if (adminDeliveryComment.length > 1200) {
    return res.status(400).json({ error: "Commentaire de livraison trop long. 1200 caractères maximum." });
  }

  try {
    const project = await getProjectForCommunicationAccess(id, req.user);
    if (!project) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const currentData = project.data && typeof project.data === "object" ? project.data : {};
    const currentCommunication = currentData.communication && typeof currentData.communication === "object" ? currentData.communication : {};
    const now = new Date().toISOString();
    const nextCommunication = { ...currentCommunication };

    if (isAdminUser) {
      nextCommunication.adminDeliveryComment = adminDeliveryComment;
      nextCommunication.admin_delivery_comment = adminDeliveryComment;
      nextCommunication.adminDeliveryCommentUpdatedAt = now;
      nextCommunication.admin_delivery_comment_updated_at = now;
    } else {
      nextCommunication.clientBrandComment = clientBrandComment;
      nextCommunication.client_brand_comment = clientBrandComment;
      nextCommunication.clientBrandCommentUpdatedAt = now;
      nextCommunication.client_brand_comment_updated_at = now;
    }

    const nextData = {
      ...currentData,
      communication: nextCommunication,
      communicationKit: {
        ...(currentData.communicationKit && typeof currentData.communicationKit === "object" ? currentData.communicationKit : {}),
        clientBrandComment: nextCommunication.clientBrandComment || "",
        adminDeliveryComment: nextCommunication.adminDeliveryComment || ""
      }
    };

    const result = await pool.query(
      `UPDATE projects
       SET data = $1::jsonb,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(nextData), id]
    );

    res.json({ ok: true, project: result.rows[0] });
  } catch (err) {
    console.error("PATCH /api/projects/:id/communication-notes", err);
    res.status(500).json({ error: "Erreur enregistrement commentaire." });
  }
});

app.patch("/api/admin/projects/:id/communication-video", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const videoDownloadUrl = String(req.body?.videoDownloadUrl || req.body?.video_download_url || "").trim();
  const videoDescription = String(req.body?.videoDescription || req.body?.video_description || "").trim();

  if (videoDownloadUrl && !isValidHttpsUrl(videoDownloadUrl)) {
    return res.status(400).json({ error: "Lien vidéo invalide. Utilisez une URL HTTPS." });
  }

  if (videoDescription.length > 800) {
    return res.status(400).json({ error: "Texte vidéo trop long. 800 caractères maximum." });
  }

  try {
    const project = await getProjectForCommunicationAccess(id, req.user);
    if (!project) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const currentData = project.data && typeof project.data === "object" ? project.data : {};
    const currentCommunication = currentData.communication && typeof currentData.communication === "object" ? currentData.communication : {};
    const nextCommunication = {
      ...currentCommunication,
      videoDownloadUrl,
      video_download_url: videoDownloadUrl,
      videoDescription,
      video_description: videoDescription,
      videoUpdatedAt: new Date().toISOString(),
      video_updated_at: new Date().toISOString()
    };

    const nextData = {
      ...currentData,
      communication: nextCommunication,
      communicationKit: {
        ...(currentData.communicationKit && typeof currentData.communicationKit === "object" ? currentData.communicationKit : {}),
        videoDownloadUrl,
        videoDescription
      }
    };

    const result = await pool.query(
      `UPDATE projects
       SET data = $1::jsonb,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(nextData), id]
    );

    res.json({ ok: true, project: result.rows[0] });
  } catch (err) {
    console.error("PATCH /api/admin/projects/:id/communication-video", err);
    res.status(500).json({ error: "Erreur enregistrement lien vidéo." });
  }
});


app.post("/api/admin/projects/:id/communication-video/notify", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const project = await getProjectForCommunicationAccess(id, req.user);
    if (!project) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const currentData = project.data && typeof project.data === "object" ? project.data : {};
    const communication = currentData.communication && typeof currentData.communication === "object" ? currentData.communication : {};
    const videoUrl = String(communication.videoDownloadUrl || communication.video_download_url || "").trim();

    if (!videoUrl) {
      return res.status(400).json({ error: "Aucun lien vidéo n’est renseigné pour ce projet." });
    }

    if (typeof sendCommunicationVideoAvailableEmail !== "function") {
      return res.status(500).json({ error: "Notification vidéo indisponible." });
    }

    const mailResult = await sendCommunicationVideoAvailableEmail(id);

    res.json({
      ok: mailResult.sent,
      emailSent: mailResult.sent,
      emailStatus: mailResult.reason || "SENT",
      to: mailResult.to || "",
      cc: mailResult.cc || ""
    });
  } catch (err) {
    console.error("POST /api/admin/projects/:id/communication-video/notify", err);
    res.status(500).json({ error: "Erreur notification vidéo de communication." });
  }
});

app.post("/api/admin/projects/:id/communication-assets/notify", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const project = await getProjectForCommunicationAccess(id, req.user);
    if (!project) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const mailResult = await sendCommunicationAssetsEmail(id);

    res.json({
      ok: mailResult.sent,
      emailSent: mailResult.sent,
      emailStatus: mailResult.reason || "SENT",
      to: mailResult.to || "",
      cc: mailResult.cc || ""
    });
  } catch (err) {
    console.error("POST /api/admin/projects/:id/communication-assets/notify", err);
    res.status(500).json({ error: "Erreur notification ressources de communication." });
  }
});


app.post("/api/admin/projects/:id/communication-links/notify", auth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const project = await getProjectForCommunicationAccess(id, req.user);
    if (!project) {
      return res.status(404).json({ error: "Projet introuvable" });
    }

    const mailResult = await sendCommunicationLinksUpdatedEmail(id);

    res.json({
      ok: mailResult.sent,
      emailSent: mailResult.sent,
      emailStatus: mailResult.reason || "SENT",
      to: mailResult.to || "",
      cc: mailResult.cc || ""
    });
  } catch (err) {
    console.error("POST /api/admin/projects/:id/communication-links/notify", err);
    res.status(500).json({ error: "Erreur notification liens de communication." });
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

app.post("/api/admin/pack-alerts/send", auth, requireAdmin, async (req, res) => {
  try {
    const mode = String(req.body?.mode || "all").toLowerCase();
    const result = await processPackAlerts({ mode });
    res.json({ ok: true, pack: result, totalSent: result.sent.length, totalSkipped: result.skipped.length });
  } catch (err) {
    console.error("Erreur alertes pack", err);
    res.status(500).json({ error: "Erreur alertes pack" });
  }
});

app.post("/api/admin/operational-alerts/send", auth, requireAdmin, async (req, res) => {
  try {
    const result = await runOperationalAlerts();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Erreur alertes opérationnelles", err);
    res.status(500).json({ error: "Erreur alertes opérationnelles" });
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

app.post("/api/operational-alerts/run", async (req, res) => {
  const secret = req.headers["x-alert-secret"] || req.query.secret || req.body?.secret || "";

  if (!ALERT_CRON_SECRET || secret !== ALERT_CRON_SECRET) {
    return res.status(403).json({ error: "Accès refusé" });
  }

  try {
    const result = await runOperationalAlerts();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Erreur run alertes opérationnelles", err);
    res.status(500).json({ error: "Erreur alertes opérationnelles" });
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
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, profile_photo_name, profile_photo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
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

    const loginUrl = buildProtectedFrontendUrl('/account.html?tab=securite&firstLogin=1');

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
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, profile_photo_name, profile_photo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
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
       RETURNING id, email, first_name, last_name, company_name, job_title, sector, organization_logo_name, organization_logo_data_url, profile_photo_name, profile_photo_data_url, passation_logo_name, passation_logo_data_url, role, status, must_change_password, passations_quota, passations_used, created_at`,
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



function extractProjectIdFromTransmissionBody(body = {}) {
  const sources = [
    body,
    body?.payload,
    body?.data,
    body?.state,
    body?.payload?.data,
    body?.payload?.state,
    body?.data?.payload,
    body?.data?.state,
    body?.state?.payload,
    body?.state?.data,
    body?.transmission,
    body?.payload?.transmission,
    body?.data?.transmission,
    body?.state?.transmission
  ].filter(item => item && typeof item === "object");

  for (const source of sources) {
    const value =
      source.projectId ||
      source.project_id ||
      source.currentProjectId ||
      source.current_project_id ||
      source.currentAdId ||
      source.current_ad_id ||
      source.adId ||
      source.ad_id ||
      source.id;

    const numeric = Number(value);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;
  }

  return null;
}

function withNotificationTargetIds(body = {}, target = {}) {
  const projectId = target.projectId || target.project_id || null;
  const organizationId = target.organizationId || target.organization_id || null;
  const userId = target.userId || target.user_id || null;
  const next = body && typeof body === "object" ? { ...body } : {};

  if (projectId) {
    next.projectId = projectId;
    next.project_id = projectId;
    next.currentProjectId = next.currentProjectId || projectId;
    next.current_project_id = next.current_project_id || projectId;
    next.currentAdId = next.currentAdId || projectId;
    next.current_ad_id = next.current_ad_id || projectId;
  }
  if (organizationId) {
    next.organizationId = organizationId;
    next.organization_id = organizationId;
  }
  if (userId) {
    next.userId = userId;
    next.user_id = userId;
  }

  if (next.payload && typeof next.payload === "object") {
    next.payload = { ...next.payload };
    if (projectId) {
      next.payload.projectId = next.payload.projectId || projectId;
      next.payload.project_id = next.payload.project_id || projectId;
      next.payload.currentProjectId = next.payload.currentProjectId || projectId;
      next.payload.current_project_id = next.payload.current_project_id || projectId;
      next.payload.currentAdId = next.payload.currentAdId || projectId;
      next.payload.current_ad_id = next.payload.current_ad_id || projectId;
    }
    if (organizationId) {
      next.payload.organizationId = next.payload.organizationId || organizationId;
      next.payload.organization_id = next.payload.organization_id || organizationId;
    }
    if (userId) {
      next.payload.userId = next.payload.userId || userId;
      next.payload.user_id = next.payload.user_id || userId;
    }
  }

  if (next.data && typeof next.data === "object") {
    next.data = { ...next.data };
    if (projectId) {
      next.data.projectId = next.data.projectId || projectId;
      next.data.project_id = next.data.project_id || projectId;
      next.data.currentAdId = next.data.currentAdId || projectId;
      next.data.current_ad_id = next.data.current_ad_id || projectId;
    }
    if (organizationId) {
      next.data.organizationId = next.data.organizationId || organizationId;
      next.data.organization_id = next.data.organization_id || organizationId;
    }
    if (userId) {
      next.data.userId = next.data.userId || userId;
      next.data.user_id = next.data.user_id || userId;
    }
  }

  return next;
}

async function enrichTransmissionPayloadForNotifications(req) {
  const body = req.body || {};
  const projectId = extractProjectIdFromTransmissionBody(body);

  if (!projectId) {
    const organizationId = await getUserPrimaryOrganizationId(req.user.id);
    return withNotificationTargetIds(body, {
      organizationId: organizationId || null,
      userId: req.user.id || null
    });
  }

  const result = await pool.query(
    `SELECT id, user_id, organization_id
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

  const row = result.rows[0];
  if (!row) {
    const organizationId = await getUserPrimaryOrganizationId(req.user.id);
    return withNotificationTargetIds(body, {
      projectId,
      organizationId: organizationId || null,
      userId: req.user.id || null
    });
  }

  return withNotificationTargetIds(body, {
    projectId: row.id,
    organizationId: row.organization_id || null,
    userId: row.user_id || req.user.id || null
  });
}

async function markProjectAsSentFromTransmission(req, options = {}) {
  const body = req.body || {};
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
  const projectId = extractProjectIdFromTransmissionBody(body);
  if (!projectId) return null;

  const isExtensionTransmission = options.isExtensionTransmission === true;
  const isReprogrammingTransmission = options.isReprogrammingTransmission === true;
  const isCampaignUpdateTransmission = isExtensionTransmission || isReprogrammingTransmission;

  const transmittedStartDate = normalizeDateValue(
    body.newStartDate || body.campaignStartDate || body.campaign_start_date || body.startDate || body.start_date ||
    payload.newStartDate || payload.campaignStartDate || payload.campaign_start_date || payload.date_lancement || payload.startDate || payload.start_date ||
    ""
  );

  const transmittedEndDate = normalizeDateValue(
    body.newEndDate || body.campaignEndDate || body.campaign_end_date || body.endDate || body.end_date ||
    payload.newEndDate || payload.campaignEndDate || payload.campaign_end_date || payload.date_cloture || payload.endDate || payload.end_date ||
    ""
  );

  const shouldUpdateStartDate = isReprogrammingTransmission && Boolean(transmittedStartDate);
  const shouldUpdateEndDate = isCampaignUpdateTransmission && Boolean(transmittedEndDate);

  const result = await pool.query(
    `UPDATE projects
     SET status = CASE WHEN $3::boolean THEN status ELSE 'sent' END,
         campaign_start_date = CASE WHEN $6::boolean THEN $8::date ELSE campaign_start_date END,
         campaign_end_date = CASE WHEN $7::boolean THEN $9::date ELSE campaign_end_date END,
         unpublished_alert_sent_at = CASE WHEN $7::boolean THEN NULL ELSE unpublished_alert_sent_at END,
         end_alert_7_sent_at = CASE WHEN $7::boolean THEN NULL ELSE end_alert_7_sent_at END,
         end_alert_2_sent_at = CASE WHEN $7::boolean THEN NULL ELSE end_alert_2_sent_at END,
         data = COALESCE(data, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
           'configTransmise', true,
           'config_transmise', true,
           'submitted', true,
           'submitted_at', NOW(),
           'status', CASE WHEN $3::boolean THEN status ELSE 'sent' END,
           'campaignStartDate', CASE WHEN $6::boolean THEN $8::text ELSE NULL END,
           'campaign_start_date', CASE WHEN $6::boolean THEN $8::text ELSE NULL END,
           'campaignEndDate', CASE WHEN $7::boolean THEN $9::text ELSE NULL END,
           'campaign_end_date', CASE WHEN $7::boolean THEN $9::text ELSE NULL END,
           'extended', COALESCE((data->>'extended')::boolean, false) OR $4::boolean,
           'isExtended', COALESCE((data->>'isExtended')::boolean, false) OR $4::boolean,
           'extended_at', CASE WHEN $4::boolean THEN NOW() ELSE data->>'extended_at' END,
           'reprogrammed', COALESCE((data->>'reprogrammed')::boolean, false) OR $5::boolean,
           'isReprogrammed', COALESCE((data->>'isReprogrammed')::boolean, false) OR $5::boolean,
           'campaign_reprogrammed', COALESCE((data->>'campaign_reprogrammed')::boolean, false) OR $5::boolean,
           'campaignReprogrammed', COALESCE((data->>'campaignReprogrammed')::boolean, false) OR $5::boolean,
           'reprogrammed_at', CASE WHEN $5::boolean THEN NOW() ELSE data->>'reprogrammed_at' END,
           'campaign_reprogrammed_at', CASE WHEN $5::boolean THEN NOW() ELSE data->>'campaign_reprogrammed_at' END,
           'transmissionType', CASE WHEN $5::boolean THEN 'reprogramming' WHEN $4::boolean THEN 'extension' ELSE COALESCE(data->>'transmissionType', 'standard') END
         )),
         current_step = 'validation',
         updated_at = NOW()
     WHERE id = $1
       AND (
         user_id = $2
         OR created_by = $2
         OR EXISTS (SELECT 1 FROM organization_users ou WHERE ou.organization_id = projects.organization_id AND ou.user_id = $2)
         OR EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.role = 'admin')
       )
     RETURNING id, status, campaign_start_date, campaign_end_date`,
    [
      projectId,
      req.user.id,
      isCampaignUpdateTransmission,
      isExtensionTransmission,
      isReprogrammingTransmission,
      shouldUpdateStartDate,
      shouldUpdateEndDate,
      transmittedStartDate,
      transmittedEndDate
    ]
  );

  return result.rows[0] || null;
}

app.post("/api/transmissions/submit", auth, async (req, res) => {
  try {
    const payloadForEmail = await enrichTransmissionPayloadForNotifications(req);
    const normalizedPayload = payloadForEmail.payload && typeof payloadForEmail.payload === "object" ? payloadForEmail.payload : payloadForEmail;
    const isExtensionTransmission =
      payloadForEmail.isExtending === true ||
      payloadForEmail.extending === true ||
      payloadForEmail.isExtension === true ||
      payloadForEmail.extension === true ||
      normalizedPayload.isExtending === true ||
      normalizedPayload.extending === true ||
      normalizedPayload.isExtension === true ||
      normalizedPayload.extension === true ||
      normalizedPayload.extended === true ||
      normalizedPayload.isExtended === true;

    const isReprogrammingTransmission =
      payloadForEmail.isReprogramming === true ||
      payloadForEmail.reprogramming === true ||
      payloadForEmail.isReprogrammingTransmission === true ||
      payloadForEmail.reprogrammingRequest === true ||
      normalizedPayload.isReprogramming === true ||
      normalizedPayload.reprogramming === true ||
      normalizedPayload.isReprogrammingTransmission === true ||
      normalizedPayload.reprogrammingRequest === true ||
      normalizedPayload.transmissionType === "reprogramming" ||
      payloadForEmail.transmissionType === "reprogramming";

    const transmissionEmail = isExtensionTransmission && typeof sendExtensionEmails === "function"
      ? await sendExtensionEmails(payloadForEmail)
      : (isReprogrammingTransmission && typeof sendReprogrammingEmails === "function")
        ? await sendReprogrammingEmails(payloadForEmail)
        : await sendTransmissionEmails(payloadForEmail);

    if (!transmissionEmail.ok) {
      const statusCode = transmissionEmail.error === "Email client manquant" || transmissionEmail.error === "Fichier Excel manquant" ? 400 : 500;
      return res.status(statusCode).json({
        ok: false,
        clientEmailSent: transmissionEmail.clientEmailSent || false,
        adminEmailSent: transmissionEmail.adminEmailSent || false,
        error: transmissionEmail.error || "Erreur transmission email backend"
      });
    }

    const ctx = transmissionEmail.ctx || {};


    const projectStatusUpdate = await markProjectAsSentFromTransmission(req, {
      isExtensionTransmission,
      isReprogrammingTransmission
    });

    return res.json({
      ok: transmissionEmail.clientEmailSent && transmissionEmail.adminEmailSent,
      clientEmailSent: transmissionEmail.clientEmailSent,
      clientEmailStatus: transmissionEmail.clientEmailStatus || "SENT",
      adminEmailSent: transmissionEmail.adminEmailSent,
      adminEmailStatus: transmissionEmail.adminEmailStatus || "SENT",
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
    runOperationalAlerts().catch((err) => console.error("Erreur alertes opérationnelles au démarrage", err));
  }, 30 * 1000);

  setInterval(() => {
    runOperationalAlerts().catch((err) => console.error("Erreur alertes opérationnelles planifiées", err));
  }, 6 * 60 * 60 * 1000);
});

