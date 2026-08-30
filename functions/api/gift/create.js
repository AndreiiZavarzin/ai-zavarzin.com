/**
 * POST /api/gift/create
 * Cloudflare Pages Function
 *
 * Creates a gift lead in D1, sends owner email via Resend,
 * returns a unique Telegram deep-link to the user.
 *
 * Environment variables (set as Cloudflare Secrets / wrangler.toml):
 *   GIFT_DB          - D1 database binding
 *   RESEND_API_KEY   - Resend API key (secret)
 *   OWNER_EMAIL      - recipient for lead notification
 *   GIFT_ACCESS_DAYS - integer, gift access duration
 *   GIFT_TOKEN_TTL_HOURS - integer, token validity window (default 72)
 *   BOT_USERNAME     - Telegram bot username, e.g. "FamiBudgetBot"
 */

const INTEREST_MAP = {
  finances: "personal_finance",
  capital: "build_capital",
  income: "extra_income",
  try: "try_gift",
  personal_finance: "personal_finance",
  build_capital: "build_capital",
  extra_income: "extra_income",
  try_gift: "try_gift",
};
const ALLOWED_LANGUAGES = ["ru", "uk", "en"];
const MAX_STRING = 500;
const MAX_NAME = 100;
const MAX_CONTACT = 200;

// ---------- helpers ----------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function errorResp(message, status = 400) {
  return jsonResp({ ok: false, error: message }, status);
}

/** Generate cryptographically random base64url token (24 bytes → 32 chars). */
async function generateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  // base64url encode (no padding; 24 % 3 === 0)
  let b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** SHA-256 hex digest of a string. */
async function sha256hex(str) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(str)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Generate a UUID v4 (for lead id). */
function uuidv4() {
  return crypto.randomUUID();
}

/** Truncate and strip a string, returning null if empty. */
function sanitize(val, max = MAX_STRING) {
  if (typeof val !== "string") return null;
  const s = val.trim().slice(0, max);
  return s || null;
}

// ---------- email ----------

async function sendOwnerEmail(env, lead, giftId) {
  const ownerEmail = env.OWNER_EMAIL || "andreiizavarzin@gmail.com";
  const resendKey = env.RESEND_API_KEY;
  if (!resendKey) {
    console.error("RESEND_API_KEY not set; skipping email");
    return { ok: false, error: "no_key" };
  }

  const interestLabels = {
    personal_finance: "Организовать личные финансы",
    build_capital: "Начать создавать капитал",
    extra_income: "Найти дополнительный доход",
    try_gift: "Просто попробовать подарок",
  };

  const html = `
<h2>Новый лид — Gift Flow</h2>
<table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif">
  <tr><td><b>Имя</b></td><td>${escapeHtml(lead.name)}</td></tr>
  <tr><td><b>Контакт</b></td><td>${escapeHtml(lead.contact)}</td></tr>
  <tr><td><b>Интерес</b></td><td>${escapeHtml(interestLabels[lead.interest] || lead.interest)}</td></tr>
  <tr><td><b>Язык</b></td><td>${escapeHtml(lead.language)}</td></tr>
  <tr><td><b>Страница</b></td><td>${escapeHtml(lead.page_url || "—")}</td></tr>
  <tr><td><b>UTM source</b></td><td>${escapeHtml(lead.utm_source || "—")}</td></tr>
  <tr><td><b>UTM medium</b></td><td>${escapeHtml(lead.utm_medium || "—")}</td></tr>
  <tr><td><b>UTM campaign</b></td><td>${escapeHtml(lead.utm_campaign || "—")}</td></tr>
  <tr><td><b>UTM content</b></td><td>${escapeHtml(lead.utm_content || "—")}</td></tr>
  <tr><td><b>UTM term</b></td><td>${escapeHtml(lead.utm_term || "—")}</td></tr>
  <tr><td><b>Дата</b></td><td>${escapeHtml(lead.created_at)}</td></tr>
  <tr><td><b>Gift ID</b></td><td>${escapeHtml(giftId)}</td></tr>
</table>
<p style="color:#888;font-size:12px">Raw token не отображается намеренно.</p>
`;

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "AI Zavarzin Bot <noreply@ai-zavarzin.com>",
        to: [ownerEmail],
        subject: `🎁 Новый лид: ${lead.name}`,
        html,
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error("Resend error:", resp.status, txt);
      return { ok: false, error: "resend_error" };
    }
    return { ok: true };
  } catch (e) {
    console.error("Resend fetch exception:", e.message);
    return { ok: false, error: "resend_exception" };
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- main handler ----------

export async function onRequestPost(context) {
  const { request, env } = context;

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("invalid_json");
  }

  // --- Validate ---

  // Honeypot
  if (body.website) {
    return jsonResp({ ok: true, telegram_url: "" }); // silently accept
  }

  // Consent is mandatory
  if (!body.consent) {
    return errorResp("consent_required");
  }

  // Name
  const name = sanitize(body.name, MAX_NAME);
  if (!name) return errorResp("name_required");

  // Contact
  const contact = sanitize(body.contact, MAX_CONTACT);
  if (!contact) return errorResp("contact_required");

  // Interest
  const rawInterest = sanitize(body.interest, 50);
  const interest = rawInterest ? INTEREST_MAP[rawInterest] : null;
  if (!interest) {
    return errorResp("interest_invalid");
  }

  // Language
  const rawLang = sanitize(body.language, 5) || "ru";
  const language = ALLOWED_LANGUAGES.includes(rawLang) ? rawLang : "ru";

  // Optional metadata
  const page_url = sanitize(body.page_url, MAX_STRING) || null;
  const utm_source = sanitize(body.utm_source, 200) || null;
  const utm_medium = sanitize(body.utm_medium, 200) || null;
  const utm_campaign = sanitize(body.utm_campaign, 200) || null;
  const utm_content = sanitize(body.utm_content, 200) || null;
  const utm_term = sanitize(body.utm_term, 200) || null;

  // --- Generate token ---
  const rawToken = await generateToken(); // 32-char base64url
  const tokenHash = await sha256hex(rawToken);

  // --- Resolve benefit_days: D1 setting → env → hardcoded default ---
  // This value is snapshotted into the gift record and never changed afterwards.
  let benefitDays = 180; // hardcoded safe default
  const db = env.GIFT_DB;
  if (!db) {
    console.error("GIFT_DB binding missing");
    return errorResp("server_error", 500);
  }
  try {
    const settingRow = await db
      .prepare(
        "SELECT setting_value FROM gift_settings WHERE setting_key = 'website_gift_days'"
      )
      .first();
    if (settingRow) {
      const parsed = parseInt(settingRow.setting_value, 10);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 3650) {
        benefitDays = parsed; // D1 wins
      } else {
        // D1 value invalid — try env
        const envDays = parseInt(env.GIFT_ACCESS_DAYS || "", 10);
        if (Number.isInteger(envDays) && envDays >= 1 && envDays <= 3650) {
          benefitDays = envDays;
        }
        // else: keep hardcoded 180
      }
    } else {
      // No D1 row yet — try env
      const envDays = parseInt(env.GIFT_ACCESS_DAYS || "", 10);
      if (Number.isInteger(envDays) && envDays >= 1 && envDays <= 3650) {
        benefitDays = envDays;
      }
      // else: keep hardcoded 180
    }
  } catch (e) {
    console.error("D1 read error (gift_settings):", e.message);
    // Fallback: try env
    const envDays = parseInt(env.GIFT_ACCESS_DAYS || "", 10);
    if (Number.isInteger(envDays) && envDays >= 1 && envDays <= 3650) {
      benefitDays = envDays;
    }
    // else: keep hardcoded 180
  }

  const tokenTtlHours = parseInt(env.GIFT_TOKEN_TTL_HOURS || "72", 10);
  const botUsername = env.BOT_USERNAME || "FamiBudgetBot";

  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + tokenTtlHours * 3600 * 1000
  ).toISOString();

  const id = uuidv4();

  // --- Save to D1 ---
  // db is already resolved above when reading gift_settings
  try {
    await db
      .prepare(
        `INSERT INTO gift_leads
         (id, token_hash, name, contact, interest, language, source,
          page_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
          consent, status, created_at, expires_at, benefit_days)
         VALUES (?, ?, ?, ?, ?, ?, 'gift_site',
                 ?, ?, ?, ?, ?, ?,
                 1, 'unused', ?, ?, ?)`
      )
      .bind(
        id, tokenHash, name, contact, interest, language,
        page_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        createdAt, expiresAt, benefitDays
      )
      .run();
  } catch (e) {
    console.error("D1 insert error:", e.message);
    return errorResp("server_error", 500);
  }

  // --- Send email (non-blocking for user) ---
  const leadForEmail = {
    name, contact, interest, language, page_url,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    created_at: createdAt,
  };
  // Register email as background task — context.waitUntil keeps the Promise
  // alive after the response is returned (Cloudflare Pages Functions lifecycle API).
  // Gift is already saved; email failure does NOT affect the D1 result.
  context.waitUntil(
    sendOwnerEmail(env, leadForEmail, id).catch((e) =>
      console.error("Email send failed:", e.message)
    )
  );

  // --- Build Telegram deep-link ---
  // rawToken stays only in this response; never persisted to D1
  const telegramUrl = `https://t.me/${botUsername}?start=gift_${rawToken}`;

  return jsonResp({ ok: true, telegram_url: telegramUrl });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
