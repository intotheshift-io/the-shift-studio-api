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
    ? "Action recommandée : recharger le pack si des campagnes sont en cours ou rendez-vous sur votre dashboard client."
    : "Action recommandée : anticiper une recharge si une campagne est en cours ou si une nouvelle publication est prévue.";

  return {
    subject: `${subjectPrefix} — ${clientName}`,
    text:
`Bonjour,

${subjectPrefix} pour le cockpit client "${clientName}".

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
    <p><strong>${escapeHtml(subjectPrefix)}</strong> pour le cockpit client <strong>${escapeHtml(clientName)}</strong>.</p>
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
    ? "recharger le pack si des campagnes sont en cours ou rendez-vous sur votre dashboard client."
    : status.type === "critical"
      ? "anticiper immédiatement une recharge."
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
    subject: `Demande de devis pack — ${recipient.clientName}`,
    text:
`Bonjour,

Une demande de pack complémentaire a été faite depuis Shift Studio.

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
    subject: `Votre demande de recharge a bien été prise en compte`,
    text:
`Bonjour ${hello},

Votre demande de recharge de pack a bien été enregistrée.

Pack demandé : ${requestedPack}
Solde actuel : ${currentRemaining}

Notre équipe revient vers vous rapidement pour valider cette recharge.

L’équipe Into The Shift`,
    html:
`<div style="font-family:Arial,sans-serif;color:#18375d;line-height:1.55;background:#f3f6f8;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dfe8ef;border-radius:18px;padding:26px">
    <p>Bonjour ${escapeHtml(hello)},</p>
    <p>Votre demande de recharge de pack a bien été enregistrée.</p>
    <div style="background:#eef6fb;border:1px solid #d7e8f1;border-radius:14px;padding:16px;margin:18px 0">
      <p style="margin:0"><strong>Pack demandé :</strong> ${escapeHtml(requestedPack)}<br>
      <strong>Solde actuel :</strong> ${escapeHtml(currentRemaining)}</p>
    </div>
    <p>Notre équipe revient vers vous rapidement pour finaliser cette recharge.</p>
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
      WHERE o.type = 'client'
        AND COALESCE(LOWER(o.passations_pack), '') <> 'illimite'
        AND COALESCE(o.passations_quota, 0) > 0
      GROUP BY o.id, creator.id, partner.id
      ORDER BY (COALESCE(o.passations_quota, 0) - COALESCE(o.passations_used, 0)) ASC, o.name ASC
    `);
  }

  async function processPackAlerts({ mode = "all" } = {}) {
    const result = await getPackAlertRows();
    const sent = [];
    const skipped = [];
    const safeMode = String(mode || "all").toLowerCase();

    for (const row of result.rows) {
      const status = getPackStatus(row);
      if (status.type === "ok") continue;
      if (safeMode !== "all" && safeMode !== status.type) continue;
      if (!shouldSendPackAlert(row, status)) {
        skipped.push({ id: row.id, type: status.type, reason: "ALREADY_SENT" });
        continue;
      }

      const recipient = getPackAlertRecipients(row, adminEmail);
      if (!recipient.internalTo) {
        skipped.push({ id: row.id, type: status.type, reason: "NO_ADMIN_RECIPIENT" });
        continue;
      }

      const internalMail = buildPackAlertInternalEmail({ row, status, recipient });
      const internalMailResult = await sendTransactionalEmail({
        to: recipient.internalTo,
        subject: internalMail.subject,
        text: internalMail.text,
        html: internalMail.html
      });

      if (!internalMailResult.sent) {
        skipped.push({ id: row.id, type: status.type, to: recipient.internalTo, reason: internalMailResult.reason || "SEND_FAILED" });
        continue;
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
      sent.push({ id: row.id, organizationName: row.name, type: status.type, internalTo: recipient.internalTo, clientTo: recipient.clientTo || "", clientCc: recipient.clientCc || "", clientEmailSent: clientMailResult.sent === true, remaining: status.remaining, quota: status.quota });
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

  async function runPackAlerts() {
    const pack = await processPackAlerts({ mode: "all" });
    return { pack, totalSent: pack.sent.length, totalSkipped: pack.skipped.length };
  }

  return { processPackAlerts, runPackAlerts, sendPackUpgradeRequestEmail };
}
