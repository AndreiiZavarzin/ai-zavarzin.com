/**
 * GET  /api/gift/settings  — return current effective website gift duration
 * POST /api/gift/settings  — set new website gift duration
 *
 * Both methods require:
 *   Authorization: Bearer <GIFT_BOT_API_SECRET>
 *
 * Environment variables:
 *   GIFT_DB             - D1 database binding
 *   GIFT_BOT_API_SECRET - shared Bearer secret with the Telegram admin bot
 *   GIFT_ACCESS_DAYS    - fallback integer (env); used when D1 row is absent/invalid
 */

const DAYS_MIN = 1;
const DAYS_MAX = 3650;
const HARDCODED_DEFAULT = 180;

// ---------- helpers ----------

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResp(code, status = 400) {
  return jsonResp({ ok: false, error: code }, status);
}

/**
 * Verify Bearer secret. Returns true if auth passes.
 * Never logs the received header value.
 */
function checkAuth(request, env) {
  const secret = env.GIFT_BOT_API_SECRET;
  if (!secret) return false;
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return false;
  return authHeader.slice(7) === secret;
}

/**
 * Resolve the effective website gift duration.
 * Priority: D1 gift_settings → GIFT_ACCESS_DAYS env → HARDCODED_DEFAULT.
 * Returns { days: number, source: "d1"|"env"|"default" }.
 */
async function resolveGiftDays(env) {
  const db = env.GIFT_DB;
  if (db) {
    try {
      const row = await db
        .prepare(
          "SELECT setting_value FROM gift_settings WHERE setting_key = 'website_gift_days'"
        )
        .first();
      if (row) {
        const parsed = parseInt(row.setting_value, 10);
        if (Number.isInteger(parsed) && parsed >= DAYS_MIN && parsed <= DAYS_MAX) {
          return { days: parsed, source: "d1" };
        }
        // D1 value present but invalid — fall through to env
      }
    } catch (e) {
      console.error("D1 read error in resolveGiftDays:", e.message);
      // Fall through to env
    }
  }

  // Fallback: env
  const envDays = parseInt(env.GIFT_ACCESS_DAYS || "", 10);
  if (Number.isInteger(envDays) && envDays >= DAYS_MIN && envDays <= DAYS_MAX) {
    return { days: envDays, source: "env" };
  }

  // Hardcoded safe default
  return { days: HARDCODED_DEFAULT, source: "default" };
}

// ---------- GET handler ----------

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!checkAuth(request, env)) {
    return errorResp("unauthorized", 401);
  }

  const { days, source } = await resolveGiftDays(env);
  return jsonResp({ ok: true, gift_access_days: days, source });
}

// ---------- POST handler ----------

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!checkAuth(request, env)) {
    return errorResp("unauthorized", 401);
  }

  const db = env.GIFT_DB;
  if (!db) {
    console.error("GIFT_DB binding missing");
    return errorResp("server_error", 500);
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("invalid_json");
  }

  const { gift_access_days, admin_telegram_user_id } = body;

  // Validate days: must be integer in [1..3650]
  if (
    !Number.isInteger(gift_access_days) ||
    gift_access_days < DAYS_MIN ||
    gift_access_days > DAYS_MAX
  ) {
    return errorResp("days_invalid");
  }

  // admin_telegram_user_id: optional but should be integer if present
  const adminTgId =
    Number.isInteger(admin_telegram_user_id) && admin_telegram_user_id > 0
      ? admin_telegram_user_id
      : null;

  // Server-side timestamp — never trust client
  const updatedAt = new Date().toISOString();

  try {
    await db
      .prepare(
        `INSERT INTO gift_settings (setting_key, setting_value, updated_at, updated_by_telegram_user_id)
         VALUES ('website_gift_days', ?, ?, ?)
         ON CONFLICT(setting_key) DO UPDATE SET
           setting_value = excluded.setting_value,
           updated_at    = excluded.updated_at,
           updated_by_telegram_user_id = excluded.updated_by_telegram_user_id`
      )
      .bind(String(gift_access_days), updatedAt, adminTgId)
      .run();
  } catch (e) {
    console.error("D1 upsert error in settings POST:", e.message);
    return errorResp("server_error", 500);
  }

  return jsonResp({
    ok: true,
    gift_access_days,
    updated_at: updatedAt,
    updated_by_telegram_user_id: adminTgId,
  });
}
