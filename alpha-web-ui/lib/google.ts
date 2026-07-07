import os from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

/**
 * Google Workspace access for the web-ui, via the OAuth client whose secrets
 * live in the central ~/Documents/.env.local (GOOGLE_CLIENT_ID / SECRET, and
 * GOOGLE_REFRESH_TOKEN after the one-time consent). Next.js doesn't load env
 * files outside the project root, so we pull that file in explicitly.
 */

const ENV_PATH =
  process.env.UPI_ENV_FILE ||
  path.join(os.homedir(), "Documents", ".env.local");

function ensureEnv() {
  // Reload each call (override) so secrets added/rotated after server start —
  // e.g. GOOGLE_REFRESH_TOKEN written during consent — are picked up without
  // restarting. The central env file is the source of truth for these keys.
  loadEnv({ path: ENV_PATH, override: true });
}

// Full-suite scopes. Changing this set requires re-running the consent flow.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
];

export class GoogleAuthError extends Error {}

/** Build an OAuth2 client from the central env (no token attached). */
export function buildOAuthClient(redirectUri?: string): OAuth2Client {
  ensureEnv();
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) {
    throw new GoogleAuthError(
      `Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in ${ENV_PATH}`
    );
  }
  return new google.auth.OAuth2(id, secret, redirectUri);
}

/** Authorized OAuth2 client using the stored refresh token. */
export function authorizedClient(): OAuth2Client {
  const oauth = buildOAuthClient();
  ensureEnv();
  const refresh = process.env.GOOGLE_REFRESH_TOKEN;
  if (!refresh) {
    throw new GoogleAuthError(
      "Google is not authorized yet. Run `npm run google:auth` in web-ui and complete the consent."
    );
  }
  oauth.setCredentials({ refresh_token: refresh });
  return oauth;
}

/** One authorized client plus a ready-to-use client per Workspace API. */
export function googleClients() {
  const auth = authorizedClient();
  return {
    auth,
    drive: google.drive({ version: "v3", auth }),
    sheets: google.sheets({ version: "v4", auth }),
    docs: google.docs({ version: "v1", auth }),
    slides: google.slides({ version: "v1", auth }),
    gmail: google.gmail({ version: "v1", auth }),
    calendar: google.calendar({ version: "v3", auth }),
  };
}

/** Map auth/permission failures to clean HTTP responses for the routes. */
export function googleErrorResponse(e: any): Response {
  const msg = e?.message || "Google request failed";
  if (e instanceof GoogleAuthError) {
    return Response.json({ error: msg, needsAuth: true }, { status: 401 });
  }
  const code =
    typeof e?.code === "number"
      ? e.code
      : typeof e?.response?.status === "number"
        ? e.response.status
        : 500;
  const detail =
    e?.response?.data?.error?.message || e?.errors?.[0]?.message || msg;
  return Response.json({ error: detail }, { status: code >= 400 ? code : 500 });
}
