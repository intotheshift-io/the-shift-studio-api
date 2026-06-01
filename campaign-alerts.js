function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function normalizeEmail(value = "") {
  return String(value || "").trim().toLowerCase();
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
  return { to, cc: ccList.join(",") };
}

function getProjectParamData(data = {}) {
  if (!data || typeof data !== "object") return {};
  const payload = data.payload && typeof data.payload === "object" ? data.payload : {};
  const state = data.state && typeof data.state === "object" ? data.state : {};
  return (
    data.parametrage || state.parametrage || payload.parametrage ||
    data.params || state.params || payload.params ||
    data.settings || state.settings || payload.settings ||
    data.meta || state.meta || payload.meta || {}
  );
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

function getCampaignAlertRecipient(row) {
  const commanditaire = extractProjectCommanditaire(row.data || {});
  const clientEmail = row.contact_email || row.user_email || "";
  const clientName = row.contact_name || row.user_company_name || `${row.user_first_name || ""} ${row.user_last_name || ""}`.trim() || commanditaire.name || "";
  const recipients = buildRecipientSet({ primary: clientEmail || commanditaire.email, cc: [commanditaire.email] });
  return { to: recipients.to, cc: recipients.cc, name: clientName };
}

function buildCampaignAlertEmail({ type, row, daysBefore, recipientName }) {
  const title = row.title || "votre autodiagnostic";
  const endDate = formatDateLongFr(row.campaign_end_date);
  const hello = recipientName || "";
  const shareUrl = row.share_url || "";
  const resultsUrl = row.results_url || "";
  const linksText = `${shareUrl ? `\nLien de passation : ${shareUrl}` : ""}${resultsUrl ? `\nLien du dashboard statistiques : ${resultsUrl}` : ""}`;
  const linksHtml = `${shareUrl ? `<p style="margin:18px 0 8px"><a href="${escapeHtml(shareUrl)}" style="display:inline-block;background:#0d4c72;color:#ffffff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">Accéder au lien de passation</a></p>` : ""}${resultsUrl ? `<p style="margin:8px 0 18px"><a href="${escapeHtml(resultsUrl)}" style="display:inline-block;background:#eef6fb;color:#0d4c72;border:1px solid #d7e8f1;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">Accéder au dashboard statistiques</a></p>` : ""}`;

  if (type === "unpublished") {
    return {
      subject: `Votre campagne est maintenant terminée — ${title}`,
      text: `Bonjour ${hello},\n\nLa campagne de votre autodiagnostic "${title}" est maintenant terminée.\n\nLes résultats restent accessibles depuis votre espace Shift Studio.\n\nDate de clôture : ${endDate}${resultsUrl ? `\n\nLien du dashboard statistiques : ${resultsUrl}` : ""}\n\nMerci pour votre confiance.\n\nL’équipe Into The Shift`,
      html: `<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55;background:#f3f6f8;padding:24px"><div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe8ef;border-radius:18px;padding:26px"><p>Bonjour ${escapeHtml(hello)},</p><p>La campagne de votre autodiagnostic <strong>${escapeHtml(title)}</strong> est maintenant terminée.</p><p>Les résultats restent accessibles depuis votre espace <strong>Shift Studio</strong>.</p><p><strong>Date de clôture :</strong> ${escapeHtml(endDate)}</p>${resultsUrl ? `<p style="margin:22px 0 10px"><a href="${escapeHtml(resultsUrl)}" style="display:inline-block;background:#0d4c72;color:#ffffff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">Accéder au dashboard statistiques</a></p>` : ""}<p>Merci pour votre confiance.</p><p>L’équipe Into The Shift</p></div></div>`
    };
  }

  return {
    subject: `Votre campagne se termine bientôt — ${title}`,
    text: `Bonjour ${hello},\n\nLa campagne de votre autodiagnostic "${title}" arrive bientôt à échéance.\n\nNous vous recommandons d’adresser le lien de votre autodiagnostic au plus grand nombre afin d’obtenir un maximum de participation.\n\nDate de clôture : ${endDate}${linksText}\n\nL’équipe Into The Shift`,
    html: `<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55;background:#f3f6f8;padding:24px"><div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe8ef;border-radius:18px;padding:26px"><p>Bonjour ${escapeHtml(hello)},</p><p>La campagne de votre autodiagnostic <strong>${escapeHtml(title)}</strong> arrive bientôt à échéance.</p><p>Nous vous recommandons d’adresser le lien de votre autodiagnostic au plus grand nombre afin d’obtenir un maximum de participation.</p><p><strong>Date de clôture :</strong> ${escapeHtml(endDate)}</p>${linksHtml}<p>L’équipe Into The Shift</p></div></div>`
  };
}


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

  const subject = payload.subject || `Votre configuration a bien été transmise à Into The Shift — ${autodiagTitle}`;

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




function buildClientReprogrammingEmail(ctx) {
  const helloName = ctx.clientName || "";
  const oldEndDate = formatDateLongFr(ctx.oldEndDate || ctx.previousEndDate || "");
  const newEndDate = formatDateLongFr(ctx.newEndDate || ctx.campaignEndDate || ctx.endDate || "");

  return {
    subject: `Votre campagne a été reprogrammée — ${ctx.autodiagTitle}`,
    text:
`Bonjour ${helloName},

La campagne "${ctx.autodiagTitle}" a bien été reprogrammée.

Ancienne date de clôture : ${oldEndDate}
Nouvelle date de clôture : ${newEndDate}

Cette reprogrammation remplace la précédente configuration de diffusion.

Accéder à Mes Autodiagnostics :
https://shiftstudio.intotheshift.io/mes-autodiagnostics.html

L’équipe Into The Shift`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55">
        <p>Bonjour ${escapeHtml(helloName)},</p>
        <p>La campagne <strong>${escapeHtml(ctx.autodiagTitle)}</strong> a bien été reprogrammée.</p>
        <p>
          <strong>Ancienne date de clôture :</strong> ${escapeHtml(oldEndDate)}<br>
          <strong>Nouvelle date de clôture :</strong> ${escapeHtml(newEndDate)}
        </p>
        <p>Cette reprogrammation remplace la précédente configuration de diffusion.</p>
        <p style="margin:22px 0 10px">
          <a href="https://shiftstudio.intotheshift.io/mes-autodiagnostics.html"
             style="display:inline-block;background:#0d4c72;color:#ffffff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">
             Accéder à Mes Autodiagnostics
          </a>
        </p>
        <p>L’équipe Into The Shift</p>
      </div>
    `
  };
}

function buildAdminReprogrammingEmail(ctx) {
  const oldEndDate = formatDateLongFr(ctx.oldEndDate || ctx.previousEndDate || "");
  const newEndDate = formatDateLongFr(ctx.newEndDate || ctx.campaignEndDate || ctx.endDate || "");

  return {
    to: "contact@intotheshift.io",
    subject: `Reprogrammation de campagne — ${ctx.companyName || "Client"} — ${ctx.autodiagTitle}`,
    text:
`Reprogrammation de campagne demandée depuis Shift Studio.

Entreprise : ${ctx.companyName || "—"}
Contact : ${ctx.clientName || "—"}
Email : ${ctx.clientEmail || "—"}
Autodiagnostic : ${ctx.autodiagTitle || "—"}
Ancienne date de clôture : ${oldEndDate}
Nouvelle date de clôture : ${newEndDate}

Action interne : republier la campagne avec les nouvelles dates et paramètres.`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55">
        <p><strong>Reprogrammation de campagne demandée depuis Shift Studio.</strong></p>
        <p>
          <strong>Entreprise :</strong> ${escapeHtml(ctx.companyName || "—")}<br>
          <strong>Contact :</strong> ${escapeHtml(ctx.clientName || "—")}<br>
          <strong>Email :</strong> ${escapeHtml(ctx.clientEmail || "—")}<br>
          <strong>Autodiagnostic :</strong> ${escapeHtml(ctx.autodiagTitle || "—")}<br>
          <strong>Ancienne date de clôture :</strong> ${escapeHtml(oldEndDate)}<br>
          <strong>Nouvelle date de clôture :</strong> ${escapeHtml(newEndDate)}
        </p>
        <p>Action interne : republier la campagne avec les nouvelles dates et paramètres.</p>
      </div>
    `
  };
}

function buildClientExtensionEmail(ctx) {
  const helloName = ctx.clientName || "";
  const oldEndDate = formatDateLongFr(ctx.oldEndDate || ctx.previousEndDate || "");
  const newEndDate = formatDateLongFr(ctx.newEndDate || ctx.campaignEndDate || ctx.endDate || "");
  const shareUrl = ctx.shareUrl || ctx.share_url || "";

  return {
    subject: `Votre campagne a été prolongée — ${ctx.autodiagTitle}`,
    text:
`Bonjour ${helloName},

La date de clôture de votre campagne "${ctx.autodiagTitle}" a bien été mise à jour.

Ancienne date de clôture : ${oldEndDate}
Nouvelle date de clôture : ${newEndDate}

Les liens de diffusion et de résultats restent inchangés.
${shareUrl ? `\nLien de passation : ${shareUrl}\n` : ""}
Vous n’avez aucune nouvelle configuration à transmettre.

L’équipe Into The Shift`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55">
        <p>Bonjour ${escapeHtml(helloName)},</p>
        <p>La date de clôture de votre campagne <strong>${escapeHtml(ctx.autodiagTitle)}</strong> a bien été mise à jour.</p>
        <div style="background:#eef6fb;border:1px solid #d7e8f1;border-radius:14px;padding:16px;margin:18px 0">
          <p style="margin:0">
            <strong>Ancienne date de clôture :</strong> ${escapeHtml(oldEndDate)}<br>
            <strong>Nouvelle date de clôture :</strong> ${escapeHtml(newEndDate)}
          </p>
        </div>
        <p>Les liens de diffusion et de résultats restent inchangés.</p>
        ${shareUrl ? `<p style="margin:22px 0 10px"><a href="${escapeHtml(shareUrl)}" style="display:inline-block;background:#0d4c72;color:#ffffff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">Accéder au lien de passation</a></p>` : ""}
        <p>Vous n’avez aucune nouvelle configuration à transmettre.</p>
        <p>L’équipe Into The Shift</p>
      </div>
    `
  };
}

function buildAdminExtensionEmail(ctx) {
  const oldEndDate = formatDateLongFr(ctx.oldEndDate || ctx.previousEndDate || "");
  const newEndDate = formatDateLongFr(ctx.newEndDate || ctx.campaignEndDate || ctx.endDate || "");

  return {
    to: "contact@intotheshift.io",
    subject: `Prolongation de campagne — ${ctx.companyName || "Client"} — ${ctx.autodiagTitle}`,
    text:
`Prolongation de campagne demandée depuis Shift Studio.

Entreprise : ${ctx.companyName || "—"}
Contact : ${ctx.clientName || "—"}
Email : ${ctx.clientEmail || "—"}
Autodiagnostic : ${ctx.autodiagTitle || "—"}
Ancienne date de clôture : ${oldEndDate}
Nouvelle date de clôture : ${newEndDate}

Action interne : vérifier que la nouvelle date de clôture est bien prise en compte sur les supports et le suivi de campagne.

Cet email concerne uniquement une prolongation : ce n’est pas une nouvelle configuration.`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55">
        <p><strong>Prolongation de campagne demandée depuis Shift Studio.</strong></p>
        <p>
          <strong>Entreprise :</strong> ${escapeHtml(ctx.companyName || "—")}<br>
          <strong>Contact :</strong> ${escapeHtml(ctx.clientName || "—")}<br>
          <strong>Email :</strong> ${escapeHtml(ctx.clientEmail || "—")}<br>
          <strong>Autodiagnostic :</strong> ${escapeHtml(ctx.autodiagTitle || "—")}<br>
          <strong>Ancienne date de clôture :</strong> ${escapeHtml(oldEndDate)}<br>
          <strong>Nouvelle date de clôture :</strong> ${escapeHtml(newEndDate)}
        </p>
        <p><strong>Action interne :</strong> vérifier que la nouvelle date de clôture est bien prise en compte sur les supports et le suivi de campagne.</p>
        <p><em>Cet email concerne uniquement une prolongation : ce n’est pas une nouvelle configuration.</em></p>
      </div>
    `
  };
}


function buildAdminTransmissionEmail(ctx) {
  return {
    to: "contact@intotheshift.io",
    subject: `Alerte transmission client — ${ctx.companyName || "Client"} — ${ctx.autodiagTitle}`,
    text:
`Alerte transmission client : une configuration a été transmise depuis Shift Studio.

Entreprise : ${ctx.companyName || "—"}
Contact : ${ctx.clientName || "—"}
Email : ${ctx.clientEmail || "—"}
Autodiagnostic : ${ctx.autodiagTitle || "—"}

Le fichier Excel de configuration est joint à cet email.`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55">
        <p><strong>Alerte transmission client : une configuration a été transmise depuis Shift Studio.</strong></p>
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
    `,
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
  };
}


export function createCampaignAlerts({ pool, sendTransactionalEmail, createNotification = null }) {
  function getNotificationProjectId(body = {}) {
    const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
    const data = body.data && typeof body.data === "object" ? body.data : {};
    const state = body.state && typeof body.state === "object" ? body.state : {};
    return (
      body.projectId || body.project_id || body.id ||
      body.currentProjectId || body.current_project_id || body.currentAdId || body.current_ad_id ||
      payload.projectId || payload.project_id || payload.id ||
      payload.currentProjectId || payload.current_project_id || payload.currentAdId || payload.current_ad_id ||
      data.projectId || data.project_id || data.currentProjectId || data.current_project_id || data.currentAdId || data.current_ad_id ||
      state.projectId || state.project_id || state.currentProjectId || state.current_project_id || state.currentAdId || state.current_ad_id ||
      null
    );
  }

  function getNotificationBodyIds(body = {}) {
    const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
    const data = body.data && typeof body.data === "object" ? body.data : {};
    const state = body.state && typeof body.state === "object" ? body.state : {};
    return {
      projectId: getNotificationProjectId(body),
      organizationId: body.organizationId || body.organization_id || payload.organizationId || payload.organization_id || data.organizationId || data.organization_id || state.organizationId || state.organization_id || null,
      userId: body.userId || body.user_id || payload.userId || payload.user_id || data.userId || data.user_id || state.userId || state.user_id || null
    };
  }

  async function resolveNotificationTarget(body = {}) {
    const ids = getNotificationBodyIds(body);
    if ((!ids.organizationId || !ids.userId) && ids.projectId) {
      try {
        const result = await pool.query(
          `SELECT user_id, organization_id FROM projects WHERE id = $1 LIMIT 1`,
          [ids.projectId]
        );
        const row = result.rows[0] || {};
        ids.organizationId = ids.organizationId || row.organization_id || null;
        ids.userId = ids.userId || row.user_id || null;
      } catch (err) {
        console.error("Erreur résolution cible notification campagne", err);
      }
    }
    return ids;
  }

  async function notifyClientFromBody(body = {}, payload = {}) {
    if (typeof createNotification !== "function") return null;
    const target = await resolveNotificationTarget(body);
    return createNotification({
      audience: "client",
      userId: target.userId || null,
      organizationId: target.organizationId || null,
      projectId: target.projectId || null,
      ...payload,
      metadata: {
        ...((payload.metadata && typeof payload.metadata === "object") ? payload.metadata : {}),
        projectId: target.projectId || null,
        organizationId: target.organizationId || null
      }
    });
  }

  async function notifyAdminFromBody(body = {}, payload = {}) {
    if (typeof createNotification !== "function") return null;
    const target = await resolveNotificationTarget(body);
    const metadata = (payload.metadata && typeof payload.metadata === "object") ? payload.metadata : {};
    return createNotification({
      audience: "admin",
      organizationId: target.organizationId || null,
      projectId: target.projectId || null,
      ...payload,
      actionUrl: target.organizationId ? `/client-folder.html?id=${encodeURIComponent(target.organizationId)}` : (payload.actionUrl || "/admin.html#organizations"),
      metadata: {
        ...metadata,
        projectId: target.projectId || null,
        organizationId: target.organizationId || null
      }
    });
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

  async function getCampaignAlertRows({ type, daysBefore }) {
    if (type === "unpublished") {
      return pool.query(`
        SELECT p.id, p.user_id, p.organization_id, p.title, p.data, p.campaign_end_date, p.results_url, p.share_url,
          o.name AS organization_name, o.contact_email, o.contact_name,
          client.email AS user_email, client.first_name AS user_first_name, client.last_name AS user_last_name, client.company_name AS user_company_name,
          partner.email AS partner_email, partner.first_name AS partner_first_name, partner.last_name AS partner_last_name, partner.company_name AS partner_company_name
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
      SELECT p.id, p.user_id, p.organization_id, p.title, p.data, p.campaign_end_date, p.results_url, p.share_url,
        o.name AS organization_name, o.contact_email, o.contact_name,
        client.email AS user_email, client.first_name AS user_first_name, client.last_name AS user_last_name, client.company_name AS user_company_name,
        partner.email AS partner_email, partner.first_name AS partner_first_name, partner.last_name AS partner_last_name, partner.company_name AS partner_company_name
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

      const mail = buildCampaignAlertEmail({ type, row, daysBefore, recipientName: recipient.name });
      const mailResult = await sendTransactionalEmail({ to: recipient.to, cc: recipient.cc || undefined, subject: mail.subject, text: mail.text, html: mail.html });

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

      if (typeof createNotification === "function") {
        await createNotification({
          audience: "client",
          userId: row.user_id || null,
          organizationId: row.organization_id || null,
          projectId: row.id,
          type: type === "unpublished" ? "unpublished" : "ending",
          title: type === "unpublished" ? "Campagne terminée" : `Campagne bientôt terminée · J-${daysBefore}`,
          message: type === "unpublished"
            ? `La campagne « ${row.title || "votre autodiagnostic"} » est maintenant terminée.`
            : `La campagne « ${row.title || "votre autodiagnostic"} » se termine dans ${daysBefore} jour${Number(daysBefore) > 1 ? "s" : ""}.`,
          actionUrl: type === "unpublished" ? `/mes-autodiagnostics.html` : `/kit-communication.html?projectId=${encodeURIComponent(row.id)}`,
          metadata: { email: type === "unpublished" ? "campaign_unpublished" : "campaign_ending", daysBefore: type === "unpublished" ? null : daysBefore }
        });
      }

      sent.push({ id: row.id, to: recipient.to, cc: recipient.cc || "", type, daysBefore: type === "unpublished" ? null : daysBefore });
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


  async function sendExtensionEmails(body = {}) {
    const ctx = buildTransmissionEmailContext(body || {});
    const sourcePayload = body.payload && typeof body.payload === "object" ? body.payload : body;

    ctx.oldEndDate =
      body.oldEndDate ||
      body.previousEndDate ||
      body.previous_end_date ||
      body.old_end_date ||
      sourcePayload.oldEndDate ||
      sourcePayload.previousEndDate ||
      sourcePayload.previous_end_date ||
      sourcePayload.old_end_date ||
      "";

    ctx.newEndDate =
      body.newEndDate ||
      body.campaignEndDate ||
      body.campaign_end_date ||
      body.endDate ||
      body.end_date ||
      sourcePayload.newEndDate ||
      sourcePayload.campaignEndDate ||
      sourcePayload.campaign_end_date ||
      sourcePayload.date_cloture ||
      sourcePayload.endDate ||
      sourcePayload.end_date ||
      "";

    ctx.shareUrl =
      body.shareUrl ||
      body.share_url ||
      sourcePayload.shareUrl ||
      sourcePayload.share_url ||
      "";

    ctx.resultsUrl =
      body.resultsUrl ||
      body.results_url ||
      sourcePayload.resultsUrl ||
      sourcePayload.results_url ||
      "";

    if (!ctx.clientEmail) {
      return {
        ok: false,
        clientEmailSent: false,
        adminEmailSent: false,
        error: "Email client manquant",
        ctx
      };
    }

    const clientEmail = buildClientExtensionEmail(ctx);
    const clientMail = await sendTransactionalEmail({
      to: ctx.clientEmail,
      subject: clientEmail.subject,
      text: clientEmail.text,
      html: clientEmail.html
    });

    const adminMailConfig = buildAdminExtensionEmail(ctx);
    const adminMail = await sendTransactionalEmail(adminMailConfig);

    if (clientMail.sent) {
      await notifyClientFromBody(body, {
        type: "extended",
        title: "Campagne prolongée",
        message: `La campagne « ${ctx.autodiagTitle || "votre autodiagnostic"} » a été prolongée.`,
        actionUrl: "/mes-autodiagnostics.html",
        metadata: { email: "campaign_extended", oldEndDate: ctx.oldEndDate || "", newEndDate: ctx.newEndDate || "" }
      });
    }

    if (adminMail.sent) {
      await notifyAdminFromBody(body, {
        type: "extended",
        title: "Prolongation de campagne",
        message: `La campagne « ${ctx.autodiagTitle || "autodiagnostic sans titre"} » a été prolongée par le client.`,
        metadata: { email: "campaign_extended_admin", clientEmail: ctx.clientEmail || "", companyName: ctx.companyName || "", oldEndDate: ctx.oldEndDate || "", newEndDate: ctx.newEndDate || "" }
      });
    }

    return {
      ok: clientMail.sent && adminMail.sent,
      ctx,
      clientEmailSent: clientMail.sent,
      clientEmailStatus: clientMail.reason || "SENT",
      adminEmailSent: adminMail.sent,
      adminEmailStatus: adminMail.reason || "SENT"
    };
  }


  async function sendReprogrammingEmails(body = {}) {
    const ctx = buildTransmissionEmailContext(body || {});
    const sourcePayload = body.payload && typeof body.payload === "object" ? body.payload : body;

    ctx.oldEndDate =
      body.oldEndDate ||
      body.previousEndDate ||
      body.previous_end_date ||
      body.old_end_date ||
      sourcePayload.oldEndDate ||
      sourcePayload.previousEndDate ||
      sourcePayload.previous_end_date ||
      sourcePayload.old_end_date ||
      "";

    ctx.newEndDate =
      body.newEndDate ||
      body.campaignEndDate ||
      body.campaign_end_date ||
      body.endDate ||
      body.end_date ||
      sourcePayload.newEndDate ||
      sourcePayload.campaignEndDate ||
      sourcePayload.campaign_end_date ||
      sourcePayload.date_cloture ||
      sourcePayload.endDate ||
      sourcePayload.end_date ||
      "";

    const clientConfig = buildClientReprogrammingEmail(ctx);

    const clientMail = await sendTransactionalEmail({
      to: ctx.clientEmail,
      subject: clientConfig.subject,
      text: clientConfig.text,
      html: clientConfig.html
    });

    const adminMail = await sendTransactionalEmail(buildAdminReprogrammingEmail(ctx));

    if (clientMail.sent) {
      await notifyClientFromBody(body, {
        type: "reprogrammed",
        title: "Campagne reprogrammée",
        message: `La campagne « ${ctx.autodiagTitle || "votre autodiagnostic"} » a été reprogrammée.`,
        actionUrl: "/mes-autodiagnostics.html",
        metadata: { email: "campaign_reprogrammed", oldEndDate: ctx.oldEndDate || "", newEndDate: ctx.newEndDate || "" }
      });
    }

    if (adminMail.sent) {
      await notifyAdminFromBody(body, {
        type: "reprogrammed",
        title: "Reprogrammation de campagne",
        message: `La campagne « ${ctx.autodiagTitle || "autodiagnostic sans titre"} » a été reprogrammée par le client.`,
        metadata: { email: "campaign_reprogrammed_admin", clientEmail: ctx.clientEmail || "", companyName: ctx.companyName || "", oldEndDate: ctx.oldEndDate || "", newEndDate: ctx.newEndDate || "" }
      });
    }

    return {
      ok: clientMail.sent && adminMail.sent,
      ctx,
      clientEmailSent: clientMail.sent,
      clientEmailStatus: clientMail.reason || "SENT",
      adminEmailSent: adminMail.sent,
      adminEmailStatus: adminMail.reason || "SENT"
    };
  }

  async function sendTransmissionEmails(body = {}) {
    const ctx = buildTransmissionEmailContext(body || {});

    if (!ctx.clientEmail) {
      return {
        ok: false,
        clientEmailSent: false,
        adminEmailSent: false,
        error: "Email client manquant",
        ctx
      };
    }

    if (!ctx.excelHtml) {
      return {
        ok: false,
        clientEmailSent: false,
        adminEmailSent: false,
        error: "Fichier Excel manquant",
        ctx
      };
    }

    const clientMail = await sendTransactionalEmail({
      to: ctx.clientEmail,
      subject: ctx.subject,
      text: buildClientRecapEmailText(ctx),
      html: buildClientRecapEmailHtml(ctx),
      attachments: ctx.recapHtml ? [
        {
          filename: ctx.recapFilename,
          content: ctx.recapHtml,
          contentType: "text/html; charset=utf-8"
        }
      ] : []
    });

    const adminMailConfig = buildAdminTransmissionEmail(ctx);
    const adminMail = await sendTransactionalEmail(adminMailConfig);

    if (clientMail.sent) {
      await notifyClientFromBody(body, {
        type: "submitted",
        title: "Configuration transmise",
        message: `Votre configuration « ${ctx.autodiagTitle || "votre autodiagnostic"} » a bien été transmise à Into The Shift.`,
        actionUrl: "/mes-autodiagnostics.html",
        metadata: { email: "transmission_client" }
      });
    }
    if (adminMail.sent) {
      await notifyAdminFromBody(body, {
        type: "submitted",
        title: "Nouvelle configuration à publier",
        message: `Une configuration client vient d’être transmise : ${ctx.autodiagTitle || "autodiagnostic sans titre"}.`,
        actionUrl: "/admin.html#organizations",
        metadata: { email: "transmission_admin", clientEmail: ctx.clientEmail || "", companyName: ctx.companyName || "" }
      });
    }

    return {
      ok: clientMail.sent && adminMail.sent,
      ctx,
      clientEmailSent: clientMail.sent,
      clientEmailStatus: clientMail.reason || "SENT",
      adminEmailSent: adminMail.sent,
      adminEmailStatus: adminMail.reason || "SENT"
    };
  }

  return { autoUnpublishExpiredProjects, processCampaignAlerts, runCampaignAlerts, sendTransmissionEmails, sendExtensionEmails, sendReprogrammingEmails };
}

