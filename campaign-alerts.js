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

export function createCampaignAlerts({ pool, sendTransactionalEmail }) {
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
        SELECT p.id, p.title, p.data, p.campaign_end_date, p.results_url, p.share_url,
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
      SELECT p.id, p.title, p.data, p.campaign_end_date, p.results_url, p.share_url,
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

  return { autoUnpublishExpiredProjects, processCampaignAlerts, runCampaignAlerts };
}
