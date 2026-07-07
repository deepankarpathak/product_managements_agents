#!/usr/bin/env node
/**
 * One-time Google OAuth consent for the web-ui.
 *
 * Reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from ~/Documents/.env.local,
 * runs the loopback consent flow in your browser, then writes the resulting
 * GOOGLE_REFRESH_TOKEN back into that same file. Run once (or again to
 * re-consent after scope changes):
 *
 *   cd web-ui && npm run google:auth
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { config as loadEnv } from "dotenv";
import { google } from "googleapis";

const ENV_PATH =
  process.env.UPI_ENV_FILE || path.join(os.homedir(), "Documents", ".env.local");
loadEnv({ path: ENV_PATH });

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
];

const id = process.env.GOOGLE_CLIENT_ID;
const secret = process.env.GOOGLE_CLIENT_SECRET;
if (!id || !secret) {
  console.error(`Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in ${ENV_PATH}`);
  process.exit(1);
}

function upsertEnv(key, value) {
  let lines = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, "utf8").split("\n")
    : [];
  let seen = false;
  lines = lines.map((s) => {
    const m = s.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[1] === key) {
      seen = true;
      return `${key}=${value}`;
    }
    return s;
  });
  if (!seen) lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, lines.join("\n").replace(/\n*$/, "") + "\n");
  fs.chmodSync(ENV_PATH, 0o600);
}

const server = http.createServer();
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const redirectUri = `http://localhost:${port}`;
  const oauth = new google.auth.OAuth2(id, secret, redirectUri);
  const authUrl = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force a refresh_token even on re-auth
    scope: SCOPES,
  });

  console.log("\nOpening your browser to authorize Google access…");
  console.log("If it doesn't open, visit this URL manually:\n\n" + authUrl + "\n");
  exec(`open "${authUrl}"`); // macOS

  server.on("request", async (req, res) => {
    if (!req.url || !req.url.startsWith("/?")) {
      res.writeHead(404).end();
      return;
    }
    const code = new URL(req.url, redirectUri).searchParams.get("code");
    if (!code) {
      res.end("No authorization code received.");
      return;
    }
    try {
      const { tokens } = await oauth.getToken(code);
      if (tokens.refresh_token) {
        upsertEnv("GOOGLE_REFRESH_TOKEN", tokens.refresh_token);
        res.end("Authorized. You can close this tab and return to the terminal.");
        console.log(`\n✓ Refresh token saved to ${ENV_PATH}`);
        console.log("  Google Workspace is now connected.\n");
        server.close();
        process.exit(0);
      } else {
        res.end("No refresh token returned — see terminal.");
        console.error(
          "\n⚠ Google returned no refresh_token. Revoke the app's access at " +
            "https://myaccount.google.com/permissions and run this again."
        );
        server.close();
        process.exit(1);
      }
    } catch (e) {
      res.end("Authorization failed: " + (e?.message || e));
      console.error("\n✗ Token exchange failed:", e?.message || e);
      server.close();
      process.exit(1);
    }
  });
});
