"""Template: connect to Google Sheets via OAuth user credentials.

Copy this file and adapt for your use case. Replace the PLACEHOLDER
values at the top. See README.md in this folder for the full methodology
and why each piece exists.
"""

# ========== PLACEHOLDERS — replace these ==========
OAUTH_CLIENT_FILE = "/path/to/your/oauth_credentials.json"  # Downloaded from Google Cloud Console
TOKEN_FILE = "/path/to/token-cache.json"                    # Where to cache the OAuth token (gitignored path)

SCOPES = [
    # Minimum scopes for create/read/write sheets:
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]
# ==================================================


# ---- DNS override for oauth2.googleapis.com ----
# Only needed on networks where the specific IP of oauth2.googleapis.com
# has a broken static route (macOS errno 49 "Can't assign requested address").
# Remove this block if your network routes googleapis.com correctly.
#
# How this works: Google's frontend routes HTTPS requests by SNI (the hostname
# sent during TLS handshake), not by IP. So connecting to any Google frontend
# IP while sending SNI=oauth2.googleapis.com works correctly. TLS validation
# still passes because the cert is matched against the SNI, not the IP.
#
# 216.239.38.223 is one of Google's frontend IPs that serves googleapis.com.
# If it ever stops working, replace with a fresh one from:
#   dig +short sheets.googleapis.com
import urllib3.util.connection as urllib3_conn

_orig_create_connection = urllib3_conn.create_connection
_OVERRIDE_IPS = {
    "oauth2.googleapis.com": "216.239.38.223",
}

def _patched_create_connection(address, *args, **kwargs):
    host, port = address
    if host in _OVERRIDE_IPS:
        address = (_OVERRIDE_IPS[host], port)
    return _orig_create_connection(address, *args, **kwargs)

urllib3_conn.create_connection = _patched_create_connection
# ---- end DNS override ----


import os
import gspread
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request


def get_creds():
    """Return valid OAuth user credentials. First call opens browser
    for consent; subsequent calls reuse the cached token and refresh
    silently when it expires."""
    creds = None
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(OAUTH_CLIENT_FILE, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_FILE, "w") as f:
            f.write(creds.to_json())
    return creds


def example_create_sheet(client, title, rows):
    """Create a new sheet and populate it. `rows` is a list of lists."""
    spreadsheet = client.create(title)
    sheet = spreadsheet.sheet1
    sheet.update(values=rows, range_name="A1")
    return spreadsheet


def example_read_sheet(client, sheet_url_or_key):
    """Read all values from the first tab of a sheet."""
    spreadsheet = client.open_by_url(sheet_url_or_key) if "/" in sheet_url_or_key else client.open_by_key(sheet_url_or_key)
    return spreadsheet.sheet1.get_all_values()


def main():
    creds = get_creds()
    client = gspread.authorize(creds)

    # --- Replace this block with your actual task ---
    rows = [
        ["Header A", "Header B"],
        ["value 1", "value 2"],
    ]
    spreadsheet = example_create_sheet(client, "My Sheet Title", rows)
    print(f"Created: {spreadsheet.url}")
    # -------------------------------------------------


if __name__ == "__main__":
    main()
