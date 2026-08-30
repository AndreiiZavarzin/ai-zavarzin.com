/**
 * POST /api/gift/claim
 * Cloudflare Pages Function — server-to-server only
 *
 * Called by FamiBudgetBot when a user opens /start gift_<TOKEN>.
 * Atomically claims the gift for a single Telegram user_id.
 *
 * benefit_expires_at is computed from gift_leads.benefit_days (snapshotted at
 * creation time) — the global website_gift_days setting is NEVER re-read here.
 *
 * Environment variables:
 *   GIFT_DB             - D1 database binding
 *   GIFT_BOT_API_SECRET - shared Bearer secret with the bot
 */

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

// ---------- main handler ----------

export async function onRequestPost(context) {
  const { request, env } = context;

  // --- Bearer auth ---
  const secret = env.GIFT_BOT_API_SECRET;
  if (!secret) {
    console.error("GIFT_BOT_API_SECRET not configured");
    return errorResp("server_misconfigured", 500);
  }

  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ") || authHeader.slice(7) !== secret) {
    // Do NOT log the received header value
    return errorResp("unauthorized", 401);
  }

  // --- Parse body ---
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("invalid_json");
  }

  const { token, telegram_user_id } = body;

  if (typeof token !== "string" || !token) {
    return errorResp("token_required");
  }
  if (
    !Number.isInteger(telegram_user_id) ||
    telegram_user_id <= 0
  ) {
    return errorResp("telegram_user_id_required");
  }

  const db = env.GIFT_DB;
  if (!db) {
    console.error("GIFT_DB binding missing");
    return errorResp("server_error", 500);
  }

  // --- Hash the incoming raw token ---
  const tokenHash = await sha256hex(token);

  const nowIso = new Date().toISOString();

  // --- Atomic conditional UPDATE ---
  // benefit_expires_at is computed from the row's own benefit_days field
  // (snapshotted at gift creation time — never from the current global setting).
  // SQLite string concatenation: '+' || benefit_days || ' days' produces a
  // valid datetime modifier such as '+90 days'.
  let updateResult;
  try {
    updateResult = await db
      .prepare(
        `UPDATE gift_leads
         SET status = 'claimed',
             telegram_user_id = ?,
             claimed_at = ?,
             benefit_expires_at = datetime(?, '+' || CAST(benefit_days AS TEXT) || ' days')
         WHERE token_hash = ?
           AND status = 'unused'
           AND expires_at > ?`
      )
      .bind(telegram_user_id, nowIso, nowIso, tokenHash, nowIso)
      .run();
  } catch (e) {
    console.error("D1 update error:", e.message);
    return errorResp("server_error", 500);
  }

  if (updateResult.meta?.changes === 1) {
    // Scenario A: successfully claimed — SELECT to get the stored benefit_expires_at
    let claimedRow;
    try {
      claimedRow = await db
        .prepare("SELECT benefit_expires_at, benefit_days FROM gift_leads WHERE token_hash = ?")
        .bind(tokenHash)
        .first();
    } catch (e) {
      console.error("D1 select after claim error:", e.message);
      return errorResp("server_error", 500);
    }
    return jsonResp({
      ok: true,
      scenario: "claimed",
      benefit_expires_at: claimedRow?.benefit_expires_at ?? null,
      benefit_days: claimedRow?.benefit_days ?? null,
    });
  }

  // --- changes === 0: need to diagnose ---
  let row;
  try {
    const sel = await db
      .prepare("SELECT * FROM gift_leads WHERE token_hash = ?")
      .bind(tokenHash)
      .first();
    row = sel;
  } catch (e) {
    console.error("D1 select error:", e.message);
    return errorResp("server_error", 500);
  }

  if (!row) {
    // No such token
    return errorResp("gift_invalid", 404);
  }

  if (row.status === "claimed") {
    if (row.telegram_user_id === telegram_user_id) {
      // Scenario B: idempotent — same user, return existing date
      return jsonResp({
        ok: true,
        scenario: "already_claimed_same_user",
        benefit_expires_at: row.benefit_expires_at,
        benefit_days: row.benefit_days,
      });
    } else {
      // Scenario C: different user owns this token
      return errorResp("gift_already_claimed", 409);
    }
  }

  if (row.status === "unused" && row.expires_at <= nowIso) {
    // Scenario D: token expired
    return errorResp("gift_expired", 410);
  }

  // Catch-all
  return errorResp("gift_invalid", 404);
}
