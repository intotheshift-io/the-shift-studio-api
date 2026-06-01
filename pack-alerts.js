const DEFAULT_ADMIN_EMAIL = "contact@intotheshift.io";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function getPackStatus(row) {
  const quota = Number(row.passations_quota || 0);
  const used = Number(row.passations_used || 0);
  const remaining = Math.max(0, quota - used);
  const remainingRate = quota > 0 ? remaining / quota : 0;

  if (remaining <= 0) return { type: "empty", label: "Pack épuisé", remaining, quota, used, remainingRate };
  if (remainingRate <= 0.10 || remaining <= 10) return { type: "critical", label: "Pack critique", remaining, quota, used, remainingRate };
  if (remainingRate <= 0.20 || remaining <= 50) return { type: "low", label: "Pack bientôt épuisé", remaining, quota, used, remainingRate };
  return { type: "ok", label: "Pack OK", remaining, quota, used, remainingRate };
}


function normalizeDateOnly(value) {
  if (!value) return "";
  const s = String(value || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function daysUntilDate(value) {
  const iso = normalizeDateOnly(value);
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function formatDateLongFr(value) {
  const iso = normalizeDateOnly(value);
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
}

function getPackExpiryType(row) {
  const days = daysUntilDate(row.pack_expires_at);
  if (days === null) return null;
  if (days <= 0) return "expired";
  if (days === 60) return "j-60";
  if (days === 30) return "j-30";
  if (days === 7) return "j-7";
  return null;
}

function shouldSendPackExpiryAlert(row, type) {
  if (type === "expired") return !row.pack_expired_processed_at;
  if (type === "j-60") return !row.pack_expiry_alert_60_sent_at;
  if (type === "j-30") return !row.pack_expiry_alert_30_sent_at;
  if (type === "j-7") return !row.pack_expiry_alert_7_sent_at;
  return false;
}

function getPackExpiryColumn(type) {
  if (type === "j-60") return "pack_expiry_alert_60_sent_at";
  if (type === "j-30") return "pack_expiry_alert_30_sent_at";
  if (type === "j-7") return "pack_expiry_alert_7_sent_at";
  return "pack_expired_processed_at";
}

function getCommanditaireEmailsFromProjectData(dataList = []) {
  const emails = [];
  const list = Array.isArray(dataList) ? dataList : [];
  for (const data of list) {
    const c = extractPackProjectCommanditaire(data || {});
    if (c.email) emails.push(c.email);
  }
  return uniqueEmails(emails);
}

function shouldSendPackAlert(row, status) {
  if (status.type === "empty") return !row.pack_alert_empty_sent_at;
  if (status.type === "critical") return !row.pack_alert_critical_sent_at;
  if (status.type === "low") return !row.pack_alert_low_sent_at;
  return false;
}

function makeFrontendUrl(path = "") {
  const base = process.env.FRONTEND_URL || "https://shiftstudio.intotheshift.io";
  const cleanPath = String(path || "").startsWith("/") ? String(path || "") : `/${path || ""}`;
  return `${base}${cleanPath}`;
}

function buildClientFolderUrl(organizationId) {
  return makeFrontendUrl(`/client-folder.html?id=${encodeURIComponent(organizationId)}`);
}

function buildAccountPackUrl() {
  return makeFrontendUrl('/account.html?tab=quota');
}

function getPackAlertRecipients(row, adminEmail) {
  const creatorName = `${row.creator_first_name || ""} ${row.creator_last_name || ""}`.trim() || row.creator_company_name || row.creator_email || "";
  const memberEmails = Array.isArray(row.organization_user_emails) ? row.organization_user_emails : [];
  const primaryClientEmail = row.creator_email || row.contact_email || memberEmails[0] || "";
  const ccEmails = uniqueEmails(row.partner_email, memberEmails, row.contact_email).filter((email) => normalizeEmail(email) !== normalizeEmail(primaryClientEmail));

  return {
    internalTo: adminEmail || DEFAULT_ADMIN_EMAIL,
    clientTo: primaryClientEmail,
    clientCc: ccEmails.join(","),
    creatorName,
    clientName: row.name || "Client sans nom",
    dashboardUrl: buildClientFolderUrl(row.id)
  };
}

function buildPackAlertInternalEmail({ row, status, recipient }) {
  const remainingPercent = status.quota > 0 ? Math.round(status.remainingRate * 100) : 0;
  const subjectPrefix = status.type === "empty" ? "Pack épuisé" : status.type === "critical" ? "Pack critique" : "Pack bientôt épuisé";
  const clientName = recipient.clientName;

  const recommendation = status.type === "empty"
    ? "Action recommandée : Recharger des crédits si des campagnes sont en cours dans l'onglet de votre compte sur votre dashboard client."
    : "Action recommandée : Anticiper une recharge de crédits si une campagne est en cours ou si une nouvelle publication est prévue.";

  return {
    subject: `${subjectPrefix} — ${clientName}`,
    text:
`Bonjour,

${subjectPrefix} pour "${clientName}".

Passations utilisées : ${status.used.toLocaleString("fr-FR")}
Quota : ${status.quota.toLocaleString("fr-FR")}
Passations restantes : ${status.remaining.toLocaleString("fr-FR")} (${remainingPercent}%)
Créateur du compte client : ${recipient.creatorName || "—"}
Contact client : ${row.contact_name || "—"} ${row.contact_email ? `<${row.contact_email}>` : ""}

${recommendation}

Alerte interne Into The Shift. Ne pas transférer telle quelle au client.

L’équipe Into The Shift`,
    html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55;background:#f3f6f8;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe8ef;border-radius:18px;padding:26px">
    <p>Bonjour,</p>
    <p><strong>${escapeHtml(subjectPrefix)}</strong> pour <strong>${escapeHtml(clientName)}</strong>.</p>
    <div style="background:#eef6fb;border:1px solid #d7e8f1;border-radius:14px;padding:16px;margin:18px 0">
      <p style="margin:0"><strong>Passations utilisées :</strong> ${escapeHtml(status.used.toLocaleString("fr-FR"))}<br>
      <strong>Quota :</strong> ${escapeHtml(status.quota.toLocaleString("fr-FR"))}<br>
      <strong>Passations restantes :</strong> ${escapeHtml(status.remaining.toLocaleString("fr-FR"))} (${escapeHtml(String(remainingPercent))}%)<br>
      <strong>Créateur du compte client :</strong> ${escapeHtml(recipient.creatorName || "—")}<br>
      <strong>Contact client :</strong> ${escapeHtml(row.contact_name || "—")} ${row.contact_email ? `— ${escapeHtml(row.contact_email)}` : ""}</p>
    </div>
    <p>${escapeHtml(recommendation)}</p>
    <p><strong>Alerte interne Into The Shift.</strong> Ne pas transférer telle quelle au client.</p>
    <p>L’équipe Into The Shift</p>
  </div>
</div>`
  };
}

function buildPackAlertClientEmail({ row, status, recipient }) {
  const clientName = recipient.clientName;
  const subjectPrefix = status.type === "empty" ? "Pack épuisé" : status.type === "critical" ? "Pack critique" : "Pack bientôt épuisé";
  const messageIntro = status.type === "empty"
    ? `Le pack de passations de "${clientName}" est maintenant épuisé.\n\nAucun de vos autodiagnostics n’est disponible désormais.`
    : status.type === "critical"
      ? `Pack critique pour "${clientName}".\n\nLe nombre de passations restantes est très faible.`
      : `Pack bientôt épuisé pour "${clientName}".`;
  const action = status.type === "empty"
    ? "recharger des crédits si des campagnes sont en cours ou rendez-vous dans l'onglet mon compte de votre dashboard client."
    : status.type === "critical"
      ? "Recharger des crédits dans l'onglet votre compte de votre dashboard."
      : "Rechargez votre pack si une campagne est en cours ou si une nouvelle publication est prévue.";

  return {
    subject: `${subjectPrefix} — ${clientName}`,
    text:
`Bonjour,

${messageIntro}

Passations utilisées : ${status.used.toLocaleString("fr-FR")}
Quota : ${status.quota.toLocaleString("fr-FR")}
Passations restantes : ${status.remaining.toLocaleString("fr-FR")}

Dashboard client :
${recipient.dashboardUrl}

Action recommandée :
${action}

L’équipe Into The Shift`,
    html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55;background:#f3f6f8;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe8ef;border-radius:18px;padding:26px">
    <p>Bonjour,</p>
    <p>${escapeHtml(messageIntro).replaceAll("\n\n", "</p><p>")}</p>
    <div style="background:#eef6fb;border:1px solid #d7e8f1;border-radius:14px;padding:16px;margin:18px 0">
      <p style="margin:0"><strong>Passations utilisées :</strong> ${escapeHtml(status.used.toLocaleString("fr-FR"))}<br>
      <strong>Quota :</strong> ${escapeHtml(status.quota.toLocaleString("fr-FR"))}<br>
      <strong>Passations restantes :</strong> ${escapeHtml(status.remaining.toLocaleString("fr-FR"))}</p>
    </div>
    <p style="margin:22px 0 10px"><a href="${escapeHtml(recipient.dashboardUrl)}" style="display:inline-block;background:#0d4c72;color:#ffffff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">Accéder au dashboard client</a></p>
    <p><strong>Action recommandée :</strong><br>${escapeHtml(action)}</p>
    <p>L’équipe Into The Shift</p>
  </div>
</div>`
  };
}


function buildPackExpiryEmail({ row, recipient, type, unpublishedCount = 0 }) {
  const clientName = recipient.clientName;
  const expiryDate = formatDateLongFr(row.pack_expires_at);
  const accountUrl = buildAccountPackUrl();
  const isExpired = type === "expired";
  const subject = isExpired
    ? `Pack expiré — campagnes dépubliées — ${clientName}`
    : `Votre pack expire bientôt — ${clientName}`;
  const lead = isExpired
    ? `Le pack annuel de "${clientName}" est arrivé à expiration. Toutes les campagnes publiées associées à ce pack ont été automatiquement dépubliées.`
    : `Le pack annuel de "${clientName}" arrive à expiration le ${expiryDate}.`;
  const action = isExpired
    ? "Pour relancer vos campagnes, rachetez des crédits depuis votre page Mon compte. Le nouveau pack ouvrira une nouvelle période de 12 mois."
    : "Pour éviter la dépublication automatique des campagnes à l’expiration, rechargez votre pack en crédits depuis votre page Mon compte.";
  return {
    subject,
    text:
`Bonjour,

${lead}

Date de fin du pack : ${expiryDate}
Campagnes dépubliées : ${unpublishedCount}

${action}

Recharger mon pack en crédits :
${accountUrl}

L’équipe Into The Shift`,
    html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55;background:#f3f6f8;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe8ef;border-radius:18px;padding:26px">
    <p>Bonjour,</p>
    <p>${escapeHtml(lead)}</p>
    <div style="background:#eef6fb;border:1px solid #d7e8f1;border-radius:14px;padding:16px;margin:18px 0">
      <p style="margin:0"><strong>Date de fin du pack :</strong> ${escapeHtml(expiryDate)}<br>
      <strong>Campagnes dépubliées :</strong> ${escapeHtml(String(unpublishedCount))}</p>
    </div>
    <p>${escapeHtml(action)}</p>
    <p style="margin:22px 0 10px"><a href="${escapeHtml(accountUrl)}" style="display:inline-block;background:#0d4c72;color:#ffffff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">Recharger mon pack en crédits</a></p>
    <p>L’équipe Into The Shift</p>
  </div>
</div>`
  };
}

function buildPackExpiryInternalEmail({ row, recipient, type, unpublishedCount = 0 }) {
  const expiryDate = formatDateLongFr(row.pack_expires_at);
  const clientName = recipient.clientName;
  const isExpired = type === "expired";
  return {
    subject: `${isExpired ? "Pack expiré" : "Pack proche expiration"} — ${clientName}`,
    text:
`Bonjour,

${isExpired ? "Le pack est expiré et les campagnes publiées ont été dépubliées." : "Le pack arrive bientôt à expiration."}

Client : ${clientName}
Date de fin du pack : ${expiryDate}
Campagnes dépubliées : ${unpublishedCount}
Contact client : ${row.contact_name || "—"} ${row.contact_email ? `<${row.contact_email}>` : ""}

Accès recharge côté client :
${buildAccountPackUrl()}

Alerte interne Into The Shift.

L’équipe Into The Shift`,
    html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55;background:#f3f6f8;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe8ef;border-radius:18px;padding:26px">
    <p>Bonjour,</p>
    <p><strong>${escapeHtml(isExpired ? "Le pack est expiré et les campagnes publiées ont été dépubliées." : "Le pack arrive bientôt à expiration.")}</strong></p>
    <div style="background:#eef6fb;border:1px solid #d7e8f1;border-radius:14px;padding:16px;margin:18px 0">
      <p style="margin:0"><strong>Client :</strong> ${escapeHtml(clientName)}<br>
      <strong>Date de fin du pack :</strong> ${escapeHtml(expiryDate)}<br>
      <strong>Campagnes dépubliées :</strong> ${escapeHtml(String(unpublishedCount))}<br>
      <strong>Contact client :</strong> ${escapeHtml(row.contact_name || "—")} ${row.contact_email ? `— ${escapeHtml(row.contact_email)}` : ""}</p>
    </div>
    <p><strong>Alerte interne Into The Shift.</strong></p>
    <p>L’équipe Into The Shift</p>
  </div>
</div>`
  };
}

function buildProjectLinksListText(projects = []) {
  const list = Array.isArray(projects) ? projects : [];
  if (!list.length) return "Aucune campagne republiée.";
  return list.map((project, index) => {
    const title = project.title || project.display_title || `Campagne ${index + 1}`;
    const shareUrl = project.share_url || project.shareUrl || "—";
    const resultsUrl = project.results_url || project.resultsUrl || "—";
    return `- ${title}\n  Lien de passation : ${shareUrl}\n  Lien résultats : ${resultsUrl}`;
  }).join("\n");
}

function buildProjectLinksListHtml(projects = []) {
  const list = Array.isArray(projects) ? projects : [];
  if (!list.length) return `<p>Aucune campagne republiée.</p>`;
  return `<ul style="padding-left:18px;margin:12px 0">${list.map((project, index) => {
    const title = project.title || project.display_title || `Campagne ${index + 1}`;
    const shareUrl = project.share_url || project.shareUrl || "";
    const resultsUrl = project.results_url || project.resultsUrl || "";
    return `<li style="margin:0 0 12px"><strong>${escapeHtml(title)}</strong><br>${shareUrl ? `Lien de passation : <a href="${escapeHtml(shareUrl)}">${escapeHtml(shareUrl)}</a><br>` : `Lien de passation : —<br>`}${resultsUrl ? `Lien résultats : <a href="${escapeHtml(resultsUrl)}">${escapeHtml(resultsUrl)}</a>` : `Lien résultats : —`}</li>`;
  }).join("")}</ul>`;
}

function buildPackRepublishedClientEmail({ row, recipient, projects = [] }) {
  const clientName = recipient.clientName;
  const count = Array.isArray(projects) ? projects.length : 0;
  const accountUrl = buildAccountPackUrl();
  return {
    subject: `Vos campagnes ont été republiées après recharge du pack — ${clientName}`,
    text:
`Bonjour,

Votre pack de crédits a été rechargé. Les campagnes qui avaient été automatiquement dépubliées à cause de l’expiration du pack ont été republiées.

Campagnes republiées : ${count}

${buildProjectLinksListText(projects)}

Accéder à mon compte :
${accountUrl}

L’équipe Into The Shift`,
    html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55;background:#f3f6f8;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe8ef;border-radius:18px;padding:26px">
    <p>Bonjour,</p>
    <p>Votre pack de crédits a été rechargé. Les campagnes qui avaient été automatiquement dépubliées à cause de l’expiration du pack ont été <strong>republiées</strong>.</p>
    <div style="background:#eef6fb;border:1px solid #d7e8f1;border-radius:14px;padding:16px;margin:18px 0">
      <p style="margin:0"><strong>Campagnes republiées :</strong> ${escapeHtml(String(count))}</p>
    </div>
    ${buildProjectLinksListHtml(projects)}
    <p style="margin:22px 0 10px"><a href="${escapeHtml(accountUrl)}" style="display:inline-block;background:#0d4c72;color:#ffffff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">Accéder à mon compte</a></p>
    <p>L’équipe Into The Shift</p>
  </div>
</div>`
  };
}

function buildPackRepublishedInternalEmail({ row, recipient, projects = [] }) {
  const clientName = recipient.clientName;
  const count = Array.isArray(projects) ? projects.length : 0;
  return {
    subject: `Campagnes republiées après recharge pack — ${clientName}`,
    text:
`Bonjour,

Le pack de crédits du client a été rechargé. Les campagnes dépubliées automatiquement pour pack expiré ont été republiées.

Client : ${clientName}
Campagnes republiées : ${count}
Contact client : ${row.contact_name || "—"} ${row.contact_email ? `<${row.contact_email}>` : ""}

${buildProjectLinksListText(projects)}

Alerte interne Into The Shift.

L’équipe Into The Shift`,
    html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55;background:#f3f6f8;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe8ef;border-radius:18px;padding:26px">
    <p>Bonjour,</p>
    <p><strong>Le pack de crédits du client a été rechargé.</strong> Les campagnes dépubliées automatiquement pour pack expiré ont été republiées.</p>
    <div style="background:#eef6fb;border:1px solid #d7e8f1;border-radius:14px;padding:16px;margin:18px 0">
      <p style="margin:0"><strong>Client :</strong> ${escapeHtml(clientName)}<br>
      <strong>Campagnes republiées :</strong> ${escapeHtml(String(count))}<br>
      <strong>Contact client :</strong> ${escapeHtml(row.contact_name || "—")} ${row.contact_email ? `— ${escapeHtml(row.contact_email)}` : ""}</p>
    </div>
    ${buildProjectLinksListHtml(projects)}
    <p><strong>Alerte interne Into The Shift.</strong></p>
    <p>L’équipe Into The Shift</p>
  </div>
</div>`
  };
}

function formatPackChoiceLabel(request = {}) {
  if (request.unlimited || request.choice === "illimite") return "Pack illimité";
  const amount = Number(request.amount || request.choice || 0);
  return Number.isFinite(amount) && amount > 0
    ? `${amount.toLocaleString("fr-FR")} passations`
    : "Pack complémentaire";
}

function firstNonEmptyValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function extractPackProjectCommanditaire(data = {}) {
  const d = data && typeof data === "object" ? data : {};
  const payload = d.payload && typeof d.payload === "object" ? d.payload : {};
  const state = d.state && typeof d.state === "object" ? d.state : {};
  const param = d.parametrage || payload.parametrage || state.parametrage || {};
  const campaign = d.campagne || d.campaign || payload.campagne || payload.campaign || state.campagne || state.campaign || {};
  const communication = d.communication || payload.communication || state.communication || {};
  const clientInfo = d.clientInfo || d.client_info || payload.clientInfo || payload.client_info || state.clientInfo || state.client_info || {};

  const firstName = firstNonEmptyValue(campaign.commanditaireFirstName, campaign.commanditaire_first_name, param.commanditaireFirstName, param.commanditaire_first_name, clientInfo.firstName, clientInfo.first_name, clientInfo.prenom);
  const lastName = firstNonEmptyValue(campaign.commanditaireLastName, campaign.commanditaire_last_name, param.commanditaireLastName, param.commanditaire_last_name, clientInfo.lastName, clientInfo.last_name, clientInfo.nom);
  const name = firstNonEmptyValue(campaign.commanditaireName, campaign.commanditaire_name, campaign.referentName, campaign.referent_name, campaign.contactName, campaign.contact_name, communication.commanditaireName, communication.commanditaire_name, param.commanditaireName, param.commanditaire_name, clientInfo.name, clientInfo.fullName, clientInfo.full_name, [firstName, lastName].filter(Boolean).join(" "));
  const email = firstNonEmptyValue(campaign.commanditaireEmail, campaign.commanditaire_email, campaign.referentEmail, campaign.referent_email, campaign.contactEmail, campaign.contact_email, communication.commanditaireEmail, communication.commanditaire_email, param.commanditaireEmail, param.commanditaire_email, d.commanditaireEmail, d.commanditaire_email, payload.commanditaireEmail, payload.commanditaire_email, state.commanditaireEmail, state.commanditaire_email, clientInfo.email, clientInfo.mail);
  return { name, email };
}

function getPackUpgradeRequestRecipients(row, adminEmail) {
  const data = row.data && typeof row.data === "object" ? row.data : {};
  const commanditaire = extractPackProjectCommanditaire(data);
  const clientName = row.organization_name || row.user_company_name || "Client sans nom";
  const requesterName =
    row.contact_name ||
    commanditaire.name ||
    `${row.user_first_name || ""} ${row.user_last_name || ""}`.trim() ||
    row.user_email ||
    "—";
  const requesterEmail = row.user_email || row.contact_email || commanditaire.email || "";

  return {
    internalTo: adminEmail || DEFAULT_ADMIN_EMAIL,
    clientTo: requesterEmail,
    clientCc: "",
    clientName,
    requesterName,
    requesterEmail,
    commanditaireName: commanditaire.name,
    commanditaireEmail: commanditaire.email
  };
}

function buildPackUpgradeInternalEmail({ row, request, recipient }) {
  const title = row.display_title || row.title || "Autodiagnostic sans titre";
  const currentQuota = Number(request.currentQuota ?? row.organization_passations_quota ?? 0);
  const currentUsed = Number(request.currentUsed ?? row.organization_passations_used ?? 0);
  const currentRemaining = request.currentRemaining === null
    ? "Illimité"
    : Math.max(0, Number(request.currentRemaining ?? (currentQuota - currentUsed) ?? 0)).toLocaleString("fr-FR");
  const requestedPack = formatPackChoiceLabel(request);
  const totalAfter = request.unlimited
    ? "Illimité"
    : Number(request.totalAfter || 0).toLocaleString("fr-FR");
  const projectUrl = `${row.frontend_url || "https://shiftstudio.intotheshift.io"}/admin.html#organizations`;

  return {
    subject: `Demande de devis pack crédits — ${recipient.clientName}`,
    text:
`Bonjour,

Une demande de crédits complémentaires a été faite depuis Shift Studio.

Client : ${recipient.clientName}
Autodiagnostic : ${title}
Pack demandé : ${requestedPack}
Solde actuel : ${currentRemaining} passations restantes
Quota actuel : ${currentQuota.toLocaleString("fr-FR")}
Passations utilisées : ${currentUsed.toLocaleString("fr-FR")}
Total après validation : ${totalAfter}
Demandeur : ${recipient.requesterName}${recipient.requesterEmail ? ` <${recipient.requesterEmail}>` : ""}

Accès admin :
${projectUrl}

Action interne : créer ou envoyer le devis dans HubSpot, puis valider la recharge dans Admin > Cockpit clients.

L’équipe Into The Shift`,
    html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55;background:#f3f6f8;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe8ef;border-radius:18px;padding:26px">
    <p>Bonjour,</p>
    <p>Une <strong>demande de pack complémentaire</strong> a été faite depuis Shift Studio.</p>
    <div style="background:#eef6fb;border:1px solid #d7e8f1;border-radius:14px;padding:16px;margin:18px 0">
      <p style="margin:0"><strong>Client :</strong> ${escapeHtml(recipient.clientName)}<br>
      <strong>Autodiagnostic :</strong> ${escapeHtml(title)}<br>
      <strong>Pack demandé :</strong> ${escapeHtml(requestedPack)}<br>
      <strong>Solde actuel :</strong> ${escapeHtml(String(currentRemaining))} passations restantes<br>
      <strong>Quota actuel :</strong> ${escapeHtml(currentQuota.toLocaleString("fr-FR"))}<br>
      <strong>Passations utilisées :</strong> ${escapeHtml(currentUsed.toLocaleString("fr-FR"))}<br>
      <strong>Total après validation :</strong> ${escapeHtml(String(totalAfter))}<br>
      <strong>Demandeur :</strong> ${escapeHtml(recipient.requesterName)}${recipient.requesterEmail ? ` — ${escapeHtml(recipient.requesterEmail)}` : ""}</p>
    </div>
    <p style="margin:22px 0 10px"><a href="${escapeHtml(projectUrl)}" style="display:inline-block;background:#0d4c72;color:#ffffff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">Ouvrir l’admin</a></p>
    <p><strong>Action interne :</strong> créer ou envoyer le devis dans HubSpot, puis valider la recharge dans <strong>Admin &gt; Cockpit clients</strong>.</p>
    <p>L’équipe Into The Shift</p>
  </div>
</div>`
  };
}

function buildPackUpgradeClientEmail({ row, request, recipient }) {
  const title = row.display_title || row.title || "votre autodiagnostic";
  const requestedPack = formatPackChoiceLabel(request);
  const currentRemaining = request.currentRemaining === null
    ? "Illimité"
    : `${Math.max(0, Number(request.currentRemaining ?? 0)).toLocaleString("fr-FR")} passations restantes`;
  const hello = recipient.requesterName && recipient.requesterName !== "—" ? recipient.requesterName : "";

  return {
    subject: `Votre demande de recharge de crédits a bien été prise en compte`,
    text:
`Bonjour ${hello},

Votre demande de recharge de crédits a bien été enregistrée.

Pack demandé : ${requestedPack}
Solde actuel : ${currentRemaining}

Notre équipe revient vers vous rapidement pour valider cette recharge.

L’équipe Into The Shift`,
    html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55;background:#f3f6f8;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe8ef;border-radius:18px;padding:26px">
    <p>Bonjour ${escapeHtml(hello)},</p>
    <p>Votre demande de recharge de crédits a bien été enregistrée.</p>
    <div style="background:#eef6fb;border:1px solid #d7e8f1;border-radius:14px;padding:16px;margin:18px 0">
      <p style="margin:0"><strong>Crédits demandés :</strong> ${escapeHtml(requestedPack)}<br>
      <strong>Solde actuel :</strong> ${escapeHtml(currentRemaining)}</p>
    </div>
    <p>Notre équipe revient vers vous rapidement pour valider cette recharge.</p>
    <p>L’équipe Into The Shift</p>
  </div>
</div>`
  };
}


function buildPackUpgradeApprovedClientEmail({ row, request, recipient }) {
  const requestedPack = formatPackChoiceLabel(request);
  const currentQuota = Number(row.organization_passations_quota || 0);
  const currentUsed = Number(row.organization_passations_used || 0);
  const isUnlimited = String(row.organization_passations_pack || "").toLowerCase() === "illimite";
  const currentRemaining = isUnlimited
    ? "Illimité"
    : `${Math.max(0, currentQuota - currentUsed).toLocaleString("fr-FR")} passations restantes`;
  const hello = recipient.requesterName && recipient.requesterName !== "—" ? recipient.requesterName : "";
  const dashboardUrl = makeFrontendUrl("/mes-autodiagnostics.html");

  return {
    subject: `Votre demande de recharge de crédits a été validée — ${recipient.clientName}`,
    text:
`Bonjour ${hello},

Votre demande de recharge de crédits a bien été validée par Into The Shift.

Pack demandé : ${requestedPack}
Nouveau quota : ${isUnlimited ? "Illimité" : currentQuota.toLocaleString("fr-FR")}
Solde actuel : ${currentRemaining}

Nous allons vous adresser un devis dans les plus brefs délais.

Accéder à votre espace Shift Studio :
${dashboardUrl}

L’équipe Into The Shift`,
    html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55;background:#f3f6f8;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe8ef;border-radius:18px;padding:26px">
    <p>Bonjour ${escapeHtml(hello)},</p>
    <p>Votre demande de recharge de crédits a bien été validée par <strong>Into The Shift</strong>.</p>
    <div style="background:#eef6fb;border:1px solid #d7e8f1;border-radius:14px;padding:16px;margin:18px 0">
      <p style="margin:0"><strong>Pack demandé :</strong> ${escapeHtml(requestedPack)}<br>
      <strong>Nouveau quota :</strong> ${isUnlimited ? "Illimité" : escapeHtml(currentQuota.toLocaleString("fr-FR"))}<br>
      <strong>Solde actuel :</strong> ${escapeHtml(currentRemaining)}</p>
    </div>
    <p>Nous allons vous adresser un devis.</p>
    <p style="margin:22px 0 10px"><a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#0d4c72;color:#ffffff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">Accéder à mon espace Shift Studio</a></p>
    <p>L’équipe Into The Shift</p>
  </div>
</div>`
  };
}


export function createPackAlerts({ pool, sendTransactionalEmail, adminEmail = DEFAULT_ADMIN_EMAIL }) {
  async function getPackAlertRows() {
    return pool.query(`
      SELECT
        o.id,
        o.name,
        o.contact_name,
        o.contact_email,
        o.passations_pack,
        o.passations_quota,
        o.passations_used,
        o.pack_alert_low_sent_at,
        o.pack_alert_critical_sent_at,
        o.pack_alert_empty_sent_at,
        o.pack_expires_at,
        o.pack_expiry_alert_60_sent_at,
        o.pack_expiry_alert_30_sent_at,
        o.pack_expiry_alert_7_sent_at,
        o.pack_expired_processed_at,
        creator.email AS creator_email,
        creator.first_name AS creator_first_name,
        creator.last_name AS creator_last_name,
        creator.company_name AS creator_company_name,
        creator.role AS creator_role,
        partner.email AS partner_email,
        COALESCE(array_agg(DISTINCT ou_user.email) FILTER (WHERE ou_user.email IS NOT NULL), '{}') AS organization_user_emails,
        COALESCE(jsonb_agg(p.data) FILTER (WHERE p.id IS NOT NULL AND p.status = 'published'), '[]'::jsonb) AS active_project_data
      FROM organizations o
      LEFT JOIN users creator ON creator.id = o.created_by
      LEFT JOIN users partner ON partner.id = o.created_by AND partner.role = 'partner'
      LEFT JOIN organization_users ou ON ou.organization_id = o.id
      LEFT JOIN users ou_user ON ou_user.id = ou.user_id AND COALESCE(ou_user.status, 'active') = 'active'
      LEFT JOIN projects p ON p.organization_id = o.id
      WHERE o.type = 'client'
        AND COALESCE(LOWER(o.passations_pack), '') <> 'illimite'
        AND COALESCE(o.passations_quota, 0) > 0
      GROUP BY o.id, creator.id, partner.id
      ORDER BY (COALESCE(o.passations_quota, 0) - COALESCE(o.passations_used, 0)) ASC, o.name ASC
    `);
  }

  async function getSinglePackAlertRow(organizationId) {
    return pool.query(`
      SELECT
        o.id,
        o.name,
        o.contact_name,
        o.contact_email,
        o.passations_pack,
        o.passations_quota,
        o.passations_used,
        o.pack_alert_low_sent_at,
        o.pack_alert_critical_sent_at,
        o.pack_alert_empty_sent_at,
        o.pack_expires_at,
        o.pack_expiry_alert_60_sent_at,
        o.pack_expiry_alert_30_sent_at,
        o.pack_expiry_alert_7_sent_at,
        o.pack_expired_processed_at,
        creator.email AS creator_email,
        creator.first_name AS creator_first_name,
        creator.last_name AS creator_last_name,
        creator.company_name AS creator_company_name,
        creator.role AS creator_role,
        partner.email AS partner_email,
        COALESCE(array_agg(DISTINCT ou_user.email) FILTER (WHERE ou_user.email IS NOT NULL), '{}') AS organization_user_emails,
        COALESCE(jsonb_agg(p.data) FILTER (WHERE p.id IS NOT NULL AND p.status = 'published'), '[]'::jsonb) AS active_project_data
      FROM organizations o
      LEFT JOIN users creator ON creator.id = o.created_by
      LEFT JOIN users partner ON partner.id = o.created_by AND partner.role = 'partner'
      LEFT JOIN organization_users ou ON ou.organization_id = o.id
      LEFT JOIN users ou_user ON ou_user.id = ou.user_id AND COALESCE(ou_user.status, 'active') = 'active'
      LEFT JOIN projects p ON p.organization_id = o.id
      WHERE o.id = $1
        AND o.type = 'client'
        AND COALESCE(LOWER(o.passations_pack), '') <> 'illimite'
        AND COALESCE(o.passations_quota, 0) > 0
      GROUP BY o.id, creator.id, partner.id
      LIMIT 1
    `, [organizationId]);
  }

  async function sendPackAlertForRow(row, { mode = "all" } = {}) {
    const safeMode = String(mode || "all").toLowerCase();
    const status = getPackStatus(row);

    if (status.type === "ok") {
      return { sent: false, skipped: true, id: row.id, type: status.type, reason: "PACK_OK", remaining: status.remaining, quota: status.quota };
    }

    if (safeMode !== "all" && safeMode !== status.type) {
      return { sent: false, skipped: true, id: row.id, type: status.type, reason: "MODE_MISMATCH", remaining: status.remaining, quota: status.quota };
    }

    if (!shouldSendPackAlert(row, status)) {
      return { sent: false, skipped: true, id: row.id, type: status.type, reason: "ALREADY_SENT", remaining: status.remaining, quota: status.quota };
    }

    const recipient = getPackAlertRecipients(row, adminEmail);
    if (!recipient.internalTo) {
      return { sent: false, skipped: true, id: row.id, type: status.type, reason: "NO_ADMIN_RECIPIENT", remaining: status.remaining, quota: status.quota };
    }

    const internalMail = buildPackAlertInternalEmail({ row, status, recipient });
    const internalMailResult = await sendTransactionalEmail({
      to: recipient.internalTo,
      subject: internalMail.subject,
      text: internalMail.text,
      html: internalMail.html
    });

    if (!internalMailResult.sent) {
      return { sent: false, skipped: true, id: row.id, type: status.type, to: recipient.internalTo, reason: internalMailResult.reason || "SEND_FAILED", remaining: status.remaining, quota: status.quota };
    }

    let clientMailResult = { sent: false, reason: "NO_CLIENT_RECIPIENT" };
    if (recipient.clientTo) {
      const clientMail = buildPackAlertClientEmail({ row, status, recipient });
      clientMailResult = await sendTransactionalEmail({
        to: recipient.clientTo,
        cc: recipient.clientCc || undefined,
        subject: clientMail.subject,
        text: clientMail.text,
        html: clientMail.html
      });
    }

    const column = status.type === "empty"
      ? "pack_alert_empty_sent_at"
      : status.type === "critical"
        ? "pack_alert_critical_sent_at"
        : "pack_alert_low_sent_at";

    await pool.query(`UPDATE organizations SET ${column} = NOW() WHERE id = $1`, [row.id]);

    return {
      sent: true,
      id: row.id,
      organizationName: row.name,
      type: status.type,
      internalTo: recipient.internalTo,
      clientTo: recipient.clientTo || "",
      clientCc: recipient.clientCc || "",
      clientEmailSent: clientMailResult.sent === true,
      remaining: status.remaining,
      quota: status.quota
    };
  }


  async function sendPackExpiryAlertForRow(row, { mode = "all" } = {}) {
    const type = getPackExpiryType(row);
    const safeMode = String(mode || "all").toLowerCase();
    if (!type) return { sent: false, skipped: true, id: row.id, reason: "NO_EXPIRY_MATCH" };
    if (!["all", "expiry", "expiration", type].includes(safeMode)) return { sent: false, skipped: true, id: row.id, type, reason: "MODE_MISMATCH" };
    if (!shouldSendPackExpiryAlert(row, type)) return { sent: false, skipped: true, id: row.id, type, reason: "ALREADY_SENT" };

    let unpublishedCount = 0;
    let unpublishedProjects = [];
    if (type === "expired") {
      const result = await pool.query(
        `UPDATE projects
         SET status = 'unpublished',
             unpublished_at = NOW(),
             unpublished_alert_sent_at = COALESCE(unpublished_alert_sent_at, NOW()),
             data = COALESCE(data, '{}'::jsonb) || jsonb_build_object(
               'packExpiredAutoUnpublished', true,
               'pack_expired_auto_unpublished', true,
               'packExpiredAutoUnpublishedAt', NOW(),
               'pack_expired_auto_unpublished_at', NOW()
             ),
             updated_at = NOW()
         WHERE organization_id = $1 AND status = 'published'
         RETURNING id, title, share_url, results_url, campaign_start_date, campaign_end_date, data`,
        [row.id]
      );
      unpublishedCount = result.rowCount || 0;
      unpublishedProjects = result.rows || [];
    }

    const recipient = getPackAlertRecipients(row, adminEmail);
    const commanditaireEmails = getCommanditaireEmailsFromProjectData(row.active_project_data || []);
    const clientCc = uniqueEmails(recipient.clientCc, commanditaireEmails).filter(email => normalizeEmail(email) !== normalizeEmail(recipient.clientTo)).join(",");
    const clientRecipient = { ...recipient, clientCc };

    const internalMail = buildPackExpiryInternalEmail({ row, recipient, type, unpublishedCount });
    const internalMailResult = await sendTransactionalEmail({
      to: recipient.internalTo,
      subject: internalMail.subject,
      text: internalMail.text,
      html: internalMail.html
    });

    let clientMailResult = { sent: false, reason: "NO_CLIENT_RECIPIENT" };
    if (clientRecipient.clientTo) {
      const clientMail = buildPackExpiryEmail({ row, recipient: clientRecipient, type, unpublishedCount });
      clientMailResult = await sendTransactionalEmail({
        to: clientRecipient.clientTo,
        cc: clientRecipient.clientCc || undefined,
        subject: clientMail.subject,
        text: clientMail.text,
        html: clientMail.html
      });
    }

    const column = getPackExpiryColumn(type);
    if (type === "expired") {
      await pool.query(
        `UPDATE organizations
         SET ${column} = NOW(),
             passations_quota = 0,
             passations_used = 0,
             passations_pack = COALESCE(NULLIF(passations_pack, ''), 'expired')
         WHERE id = $1`,
        [row.id]
      );
    } else {
      await pool.query(`UPDATE organizations SET ${column} = NOW() WHERE id = $1`, [row.id]);
    }
    return {
      sent: true,
      id: row.id,
      organizationName: row.name,
      type,
      internalTo: recipient.internalTo,
      clientTo: clientRecipient.clientTo || "",
      clientCc: clientRecipient.clientCc || "",
      internalEmailSent: internalMailResult.sent === true,
      clientEmailSent: clientMailResult.sent === true,
      unpublishedCount,
      packExpiresAt: row.pack_expires_at
    };
  }

  async function sendPackAlertForOrganization(organizationId, { mode = "all" } = {}) {
    const result = await getSinglePackAlertRow(organizationId);
    const row = result.rows[0];

    if (!row) {
      return { sent: false, skipped: true, id: organizationId, reason: "ORGANIZATION_NOT_ELIGIBLE" };
    }

    const expiryResult = await sendPackExpiryAlertForRow(row, { mode });
    if (expiryResult.sent || (expiryResult.skipped && expiryResult.type === "expired")) {
      return expiryResult;
    }

    return sendPackAlertForRow(row, { mode });
  }

  async function processPackAlerts({ mode = "all" } = {}) {
    const result = await getPackAlertRows();
    const sent = [];
    const skipped = [];

    for (const row of result.rows) {
      const expiryResult = await sendPackExpiryAlertForRow(row, { mode });
      if (expiryResult.sent) sent.push(expiryResult);
      else if (expiryResult.skipped && expiryResult.reason !== "NO_EXPIRY_MATCH") skipped.push(expiryResult);

      const alertResult = await sendPackAlertForRow(row, { mode });
      if (alertResult.sent) {
        sent.push(alertResult);
      } else if (alertResult.skipped) {
        skipped.push(alertResult);
      }
    }

    return { sent, skipped };
  }

  async function sendPackUpgradeRequestEmail(projectId) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(`
        SELECT
          p.id,
          p.title,
          p.data,
          COALESCE(
            NULLIF(p.data->'parametrage'->>'titre_repondants', ''),
            NULLIF(p.data->'parametrage'->>'titreRespondants', ''),
            NULLIF(p.data->'parametrage'->>'titre_visible_repondants', ''),
            NULLIF(p.data->'parametrage'->>'titreVisibleRepondants', ''),
            NULLIF(p.data->'parametrage'->>'titre', ''),
            p.title
          ) AS display_title,
          o.name AS organization_name,
          o.contact_name,
          o.contact_email,
          o.passations_pack AS organization_passations_pack,
          o.passations_quota AS organization_passations_quota,
          o.passations_used AS organization_passations_used,
          client_user.email AS user_email,
          client_user.first_name AS user_first_name,
          client_user.last_name AS user_last_name,
          client_user.company_name AS user_company_name,
          partner.email AS partner_email
        FROM projects p
        LEFT JOIN organizations o ON o.id = p.organization_id
        LEFT JOIN users client_user ON client_user.id = p.user_id
        LEFT JOIN users partner ON partner.id = o.created_by AND partner.role = 'partner'
        WHERE p.id = $1
        FOR UPDATE OF p
      `, [projectId]);

      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { sent: false, reason: "PROJECT_NOT_FOUND" };
      }

      const data = row.data && typeof row.data === "object" ? row.data : {};
      const param = data.parametrage && typeof data.parametrage === "object" ? data.parametrage : {};
      const alreadySentAt = data.pack_upgrade_email_sent_at || data.packUpgradeEmailSentAt || param.pack_upgrade_email_sent_at || param.packUpgradeEmailSentAt;
      if (alreadySentAt) {
        await client.query("COMMIT");
        return { sent: false, reason: "ALREADY_SENT" };
      }

      const requested = data.pack_upgrade_requested === true || data.packUpgradeRequested === true || param.pack_upgrade_requested === true || param.packUpgradeRequested === true;
      const status = String(data.pack_upgrade_status || data.packUpgradeStatus || param.pack_upgrade_status || param.packUpgradeStatus || "").toLowerCase();
      if (!requested || status !== "pending") {
        await client.query("ROLLBACK");
        return { sent: false, reason: "NO_PENDING_REQUEST" };
      }

      const request = {
        requested: true,
        status: "pending",
        choice: data.pack_upgrade_choice || data.packUpgradeChoice || param.pack_upgrade_choice || param.packUpgradeChoice || "",
        amount: data.pack_upgrade_amount ?? data.packUpgradeAmount ?? param.pack_upgrade_amount ?? param.packUpgradeAmount ?? null,
        totalAfter: data.pack_upgrade_total_after ?? data.packUpgradeTotalAfter ?? param.pack_upgrade_total_after ?? param.packUpgradeTotalAfter ?? null,
        unlimited: data.pack_upgrade_unlimited === true || data.packUpgradeUnlimited === true || param.pack_upgrade_unlimited === true || param.packUpgradeUnlimited === true,
        currentQuota: row.organization_passations_quota,
        currentUsed: row.organization_passations_used,
        currentRemaining: String(row.organization_passations_pack || "").toLowerCase() === "illimite" ? null : Math.max(0, Number(row.organization_passations_quota || 0) - Number(row.organization_passations_used || 0))
      };

      const recipient = getPackUpgradeRequestRecipients(row, adminEmail);
      if (!recipient.internalTo) {
        await client.query("ROLLBACK");
        return { sent: false, reason: "NO_ADMIN_RECIPIENT" };
      }

      const sentAt = new Date().toISOString();
      const nextData = {
        ...data,
        pack_upgrade_email_sent_at: sentAt,
        packUpgradeEmailSentAt: sentAt,
        parametrage: {
          ...param,
          pack_upgrade_email_sent_at: sentAt,
          packUpgradeEmailSentAt: sentAt
        }
      };

      await client.query(`UPDATE projects SET data = $1::jsonb, updated_at = NOW() WHERE id = $2`, [JSON.stringify(nextData), projectId]);
      await client.query("COMMIT");

      const rowWithFrontend = { ...row, frontend_url: process.env.FRONTEND_URL || "https://shiftstudio.intotheshift.io" };
      const internalMail = buildPackUpgradeInternalEmail({ row: rowWithFrontend, request, recipient });
      const internalMailResult = await sendTransactionalEmail({
        to: recipient.internalTo,
        subject: internalMail.subject,
        text: internalMail.text,
        html: internalMail.html
      });

      let clientMailResult = { sent: false, reason: "NO_CLIENT_RECIPIENT" };
      if (recipient.clientTo) {
        const clientMail = buildPackUpgradeClientEmail({ row: rowWithFrontend, request, recipient });
        clientMailResult = await sendTransactionalEmail({
          to: recipient.clientTo,
          cc: recipient.clientCc || undefined,
          subject: clientMail.subject,
          text: clientMail.text,
          html: clientMail.html
        });
      }

      return {
        sent: internalMailResult.sent === true,
        internalTo: recipient.internalTo,
        clientTo: recipient.clientTo || "",
        clientCc: recipient.clientCc || "",
        clientEmailSent: clientMailResult.sent === true,
        reason: internalMailResult.reason || ""
      };
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }


  async function sendAccountPackUpgradeRequestEmail({ organizationId, userId, packChoice }) {
    const choice = String(packChoice || '').trim();
    if (!choice || choice === 'current_pack' || choice === 'existing') {
      return { sent: false, reason: 'INVALID_PACK_CHOICE' };
    }

    const amount = choice === 'illimite' ? null : Number(choice || 0);
    if (choice !== 'illimite' && (!Number.isFinite(amount) || amount <= 0)) {
      return { sent: false, reason: 'INVALID_PACK_CHOICE' };
    }

    const result = await pool.query(`
      SELECT
        o.id AS organization_id,
        o.name AS organization_name,
        o.contact_name,
        o.contact_email,
        o.passations_pack AS organization_passations_pack,
        o.passations_quota AS organization_passations_quota,
        o.passations_used AS organization_passations_used,
        client_user.email AS user_email,
        client_user.first_name AS user_first_name,
        client_user.last_name AS user_last_name,
        client_user.company_name AS user_company_name,
        partner.email AS partner_email
      FROM organizations o
      LEFT JOIN users client_user ON client_user.id = $2
      LEFT JOIN users partner ON partner.id = o.created_by AND partner.role = 'partner'
      WHERE o.id = $1
      LIMIT 1
    `, [organizationId, userId]);

    const row = result.rows[0];
    if (!row) return { sent: false, reason: 'ORGANIZATION_NOT_FOUND' };

    const currentQuota = Number(row.organization_passations_quota || 0);
    const currentUsed = Number(row.organization_passations_used || 0);
    const isCurrentUnlimited = String(row.organization_passations_pack || '').toLowerCase() === 'illimite';

    if (isCurrentUnlimited && choice !== 'illimite') {
      return { sent: false, reason: 'NOT_REQUIRED_UNLIMITED_PACK' };
    }

    const request = {
      requested: true,
      status: 'pending',
      choice,
      amount,
      totalAfter: choice === 'illimite' ? null : currentQuota + amount,
      unlimited: choice === 'illimite',
      currentQuota,
      currentUsed,
      currentRemaining: isCurrentUnlimited ? null : Math.max(0, currentQuota - currentUsed)
    };

    const mailRow = {
      id: null,
      title: 'Demande de recharge depuis Mon compte',
      display_title: 'Recharge de crédits',
      data: {},
      organization_name: row.organization_name,
      contact_name: row.contact_name,
      contact_email: row.contact_email,
      organization_passations_pack: row.organization_passations_pack,
      organization_passations_quota: row.organization_passations_quota,
      organization_passations_used: row.organization_passations_used,
      user_email: row.user_email,
      user_first_name: row.user_first_name,
      user_last_name: row.user_last_name,
      user_company_name: row.user_company_name,
      partner_email: row.partner_email,
      frontend_url: process.env.FRONTEND_URL || 'https://shiftstudio.intotheshift.io'
    };

    const recipient = getPackUpgradeRequestRecipients(mailRow, adminEmail);
    if (!recipient.internalTo) return { sent: false, reason: 'NO_ADMIN_RECIPIENT' };

    const internalMail = buildPackUpgradeInternalEmail({ row: mailRow, request, recipient });
    const internalMailResult = await sendTransactionalEmail({
      to: recipient.internalTo,
      subject: internalMail.subject,
      text: internalMail.text,
      html: internalMail.html
    });

    let clientMailResult = { sent: false, reason: 'NO_CLIENT_RECIPIENT' };
    if (recipient.clientTo) {
      const clientMail = buildPackUpgradeClientEmail({ row: mailRow, request, recipient });
      clientMailResult = await sendTransactionalEmail({
        to: recipient.clientTo,
        cc: recipient.clientCc || undefined,
        subject: clientMail.subject,
        text: clientMail.text,
        html: clientMail.html
      });
    }

    return {
      sent: internalMailResult.sent === true,
      internalTo: recipient.internalTo,
      clientTo: recipient.clientTo || '',
      clientCc: recipient.clientCc || '',
      clientEmailSent: clientMailResult.sent === true,
      reason: internalMailResult.reason || ''
    };
  }

  async function sendPackUpgradeApprovedEmail(projectId) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(`
        SELECT
          p.id,
          p.title,
          p.data,
          COALESCE(
            NULLIF(p.data->'parametrage'->>'titre_repondants', ''),
            NULLIF(p.data->'parametrage'->>'titreRespondants', ''),
            NULLIF(p.data->'parametrage'->>'titre_visible_repondants', ''),
            NULLIF(p.data->'parametrage'->>'titreVisibleRepondants', ''),
            NULLIF(p.data->'parametrage'->>'titre', ''),
            p.title
          ) AS display_title,
          o.name AS organization_name,
          o.contact_name,
          o.contact_email,
          o.passations_pack AS organization_passations_pack,
          o.passations_quota AS organization_passations_quota,
          o.passations_used AS organization_passations_used,
          client_user.email AS user_email,
          client_user.first_name AS user_first_name,
          client_user.last_name AS user_last_name,
          client_user.company_name AS user_company_name,
          partner.email AS partner_email
        FROM projects p
        LEFT JOIN organizations o ON o.id = p.organization_id
        LEFT JOIN users client_user ON client_user.id = p.user_id
        LEFT JOIN users partner ON partner.id = o.created_by AND partner.role = 'partner'
        WHERE p.id = $1
        FOR UPDATE OF p
      `, [projectId]);

      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { sent: false, reason: "PROJECT_NOT_FOUND" };
      }

      const data = row.data && typeof row.data === "object" ? row.data : {};
      const param = data.parametrage && typeof data.parametrage === "object" ? data.parametrage : {};
      const alreadySentAt = data.pack_upgrade_approved_email_sent_at || data.packUpgradeApprovedEmailSentAt || param.pack_upgrade_approved_email_sent_at || param.packUpgradeApprovedEmailSentAt;
      if (alreadySentAt) {
        await client.query("COMMIT");
        return { sent: false, reason: "ALREADY_SENT" };
      }

      const request = {
        requested: data.pack_upgrade_requested === true || data.packUpgradeRequested === true || param.pack_upgrade_requested === true || param.packUpgradeRequested === true,
        status: String(data.pack_upgrade_status || data.packUpgradeStatus || param.pack_upgrade_status || param.packUpgradeStatus || "").toLowerCase(),
        choice: data.pack_upgrade_choice || data.packUpgradeChoice || param.pack_upgrade_choice || param.packUpgradeChoice || "",
        amount: data.pack_upgrade_amount ?? data.packUpgradeAmount ?? param.pack_upgrade_amount ?? param.packUpgradeAmount ?? null,
        totalAfter: data.pack_upgrade_total_after ?? data.packUpgradeTotalAfter ?? param.pack_upgrade_total_after ?? param.packUpgradeTotalAfter ?? null,
        unlimited: data.pack_upgrade_unlimited === true || data.packUpgradeUnlimited === true || param.pack_upgrade_unlimited === true || param.packUpgradeUnlimited === true
      };

      if (!request.requested || request.status !== "approved") {
        await client.query("ROLLBACK");
        return { sent: false, reason: "NO_APPROVED_REQUEST" };
      }

      const recipient = getPackUpgradeRequestRecipients(row, adminEmail);
      if (!recipient.clientTo) {
        await client.query("ROLLBACK");
        return { sent: false, reason: "NO_CLIENT_RECIPIENT" };
      }

      const sentAt = new Date().toISOString();
      const nextData = {
        ...data,
        pack_upgrade_approved_email_sent_at: sentAt,
        packUpgradeApprovedEmailSentAt: sentAt,
        parametrage: {
          ...param,
          pack_upgrade_approved_email_sent_at: sentAt,
          packUpgradeApprovedEmailSentAt: sentAt
        }
      };

      await client.query(`UPDATE projects SET data = $1::jsonb, updated_at = NOW() WHERE id = $2`, [JSON.stringify(nextData), projectId]);
      await client.query("COMMIT");

      const clientMail = buildPackUpgradeApprovedClientEmail({ row, request, recipient });
      const clientMailResult = await sendTransactionalEmail({
        to: recipient.clientTo,
        cc: recipient.clientCc || undefined,
        subject: clientMail.subject,
        text: clientMail.text,
        html: clientMail.html
      });

      return {
        sent: clientMailResult.sent === true,
        clientTo: recipient.clientTo || "",
        clientCc: recipient.clientCc || "",
        reason: clientMailResult.reason || ""
      };
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }


  async function sendAccountPackUpgradeApprovedEmail(organizationId) {
    const result = await pool.query(`
      SELECT
        o.id AS organization_id,
        o.name AS organization_name,
        o.contact_name,
        o.contact_email,
        o.passations_pack AS organization_passations_pack,
        o.passations_quota AS organization_passations_quota,
        o.passations_used AS organization_passations_used,
        o.pack_upgrade_requested,
        o.pack_upgrade_status,
        o.pack_upgrade_choice,
        o.pack_upgrade_amount,
        o.pack_upgrade_total_after,
        o.pack_upgrade_unlimited,
        o.pack_upgrade_requested_by_email,
        o.pack_upgrade_approved_email_sent_at,
        requester.email AS user_email,
        requester.first_name AS user_first_name,
        requester.last_name AS user_last_name,
        requester.company_name AS user_company_name,
        partner.email AS partner_email
      FROM organizations o
      LEFT JOIN users requester ON requester.id = o.pack_upgrade_requested_by
      LEFT JOIN users partner ON partner.id = o.created_by AND partner.role = 'partner'
      WHERE o.id = $1
      LIMIT 1
    `, [organizationId]);

    const row = result.rows[0];
    if (!row) return { sent: false, reason: 'ORGANIZATION_NOT_FOUND' };
    if (row.pack_upgrade_approved_email_sent_at) return { sent: false, reason: 'ALREADY_SENT' };

    const request = {
      requested: row.pack_upgrade_requested === true,
      status: String(row.pack_upgrade_status || '').toLowerCase(),
      choice: row.pack_upgrade_choice || '',
      amount: row.pack_upgrade_amount,
      totalAfter: row.pack_upgrade_total_after,
      unlimited: row.pack_upgrade_unlimited === true
    };

    if (!request.requested || request.status !== 'approved') {
      return { sent: false, reason: 'NO_APPROVED_REQUEST' };
    }

    const mailRow = {
      id: null,
      title: 'Recharge de crédits validée',
      display_title: 'Recharge de crédits',
      data: {},
      organization_name: row.organization_name,
      contact_name: row.contact_name,
      contact_email: row.contact_email,
      organization_passations_pack: row.organization_passations_pack,
      organization_passations_quota: row.organization_passations_quota,
      organization_passations_used: row.organization_passations_used,
      user_email: row.user_email || row.pack_upgrade_requested_by_email || row.contact_email,
      user_first_name: row.user_first_name,
      user_last_name: row.user_last_name,
      user_company_name: row.user_company_name,
      partner_email: row.partner_email,
      frontend_url: process.env.FRONTEND_URL || 'https://shiftstudio.intotheshift.io'
    };

    const recipient = getPackUpgradeRequestRecipients(mailRow, adminEmail);
    if (!recipient.clientTo) return { sent: false, reason: 'NO_CLIENT_RECIPIENT' };

    const clientMail = buildPackUpgradeApprovedClientEmail({ row: mailRow, request, recipient });
    const clientMailResult = await sendTransactionalEmail({
      to: recipient.clientTo,
      cc: recipient.clientCc || undefined,
      subject: clientMail.subject,
      text: clientMail.text,
      html: clientMail.html
    });

    if (clientMailResult.sent) {
      await pool.query(`UPDATE organizations SET pack_upgrade_approved_email_sent_at = NOW() WHERE id = $1`, [organizationId]);
    }

    return {
      sent: clientMailResult.sent === true,
      clientTo: recipient.clientTo || '',
      clientCc: recipient.clientCc || '',
      reason: clientMailResult.reason || ''
    };
  }

  async function sendPackRepublishedAfterRechargeEmail({ organizationId, projects = [] } = {}) {
    const orgId = Number(organizationId);
    const republishedProjects = Array.isArray(projects) ? projects : [];
    if (!Number.isInteger(orgId) || orgId <= 0) return { sent: false, reason: "INVALID_ORGANIZATION" };
    if (!republishedProjects.length) return { sent: false, reason: "NO_REPUBLISHED_PROJECTS" };

    const result = await pool.query(`
      SELECT
        o.id,
        o.name,
        o.contact_name,
        o.contact_email,
        o.passations_pack,
        o.passations_quota,
        o.passations_used,
        creator.email AS creator_email,
        creator.first_name AS creator_first_name,
        creator.last_name AS creator_last_name,
        creator.company_name AS creator_company_name,
        creator.role AS creator_role,
        partner.email AS partner_email,
        COALESCE(array_agg(DISTINCT ou_user.email) FILTER (WHERE ou_user.email IS NOT NULL), '{}') AS organization_user_emails
      FROM organizations o
      LEFT JOIN users creator ON creator.id = o.created_by
      LEFT JOIN users partner ON partner.id = o.created_by AND partner.role = 'partner'
      LEFT JOIN organization_users ou ON ou.organization_id = o.id
      LEFT JOIN users ou_user ON ou_user.id = ou.user_id AND COALESCE(ou_user.status, 'active') = 'active'
      WHERE o.id = $1 AND o.type = 'client'
      GROUP BY o.id, creator.id, partner.id
      LIMIT 1
    `, [orgId]);

    const row = result.rows[0];
    if (!row) return { sent: false, reason: "ORGANIZATION_NOT_FOUND" };

    const recipient = getPackAlertRecipients(row, adminEmail);
    const commanditaireEmails = getCommanditaireEmailsFromProjectData(republishedProjects.map(project => project.data || {}));
    const clientCc = uniqueEmails(recipient.clientCc, commanditaireEmails).filter(email => normalizeEmail(email) !== normalizeEmail(recipient.clientTo)).join(",");
    const clientRecipient = { ...recipient, clientCc };

    const internalMail = buildPackRepublishedInternalEmail({ row, recipient, projects: republishedProjects });
    const internalMailResult = await sendTransactionalEmail({
      to: recipient.internalTo,
      subject: internalMail.subject,
      text: internalMail.text,
      html: internalMail.html
    });

    let clientMailResult = { sent: false, reason: "NO_CLIENT_RECIPIENT" };
    if (clientRecipient.clientTo) {
      const clientMail = buildPackRepublishedClientEmail({ row, recipient: clientRecipient, projects: republishedProjects });
      clientMailResult = await sendTransactionalEmail({
        to: clientRecipient.clientTo,
        cc: clientRecipient.clientCc || undefined,
        subject: clientMail.subject,
        text: clientMail.text,
        html: clientMail.html
      });
    }

    return {
      sent: internalMailResult.sent === true || clientMailResult.sent === true,
      internalEmailSent: internalMailResult.sent === true,
      clientEmailSent: clientMailResult.sent === true,
      internalTo: recipient.internalTo,
      clientTo: clientRecipient.clientTo || "",
      clientCc: clientRecipient.clientCc || "",
      republishedCount: republishedProjects.length,
      reason: internalMailResult.reason || clientMailResult.reason || ""
    };
  }

  async function runPackAlerts() {
    const pack = await processPackAlerts({ mode: "all" });
    return { pack, totalSent: pack.sent.length, totalSkipped: pack.skipped.length };
  }

  return { processPackAlerts, runPackAlerts, sendPackExpiryAlertForRow, sendPackAlertForOrganization, sendPackUpgradeRequestEmail, sendPackUpgradeApprovedEmail, sendAccountPackUpgradeRequestEmail, sendAccountPackUpgradeApprovedEmail, sendPackRepublishedAfterRechargeEmail };
}
