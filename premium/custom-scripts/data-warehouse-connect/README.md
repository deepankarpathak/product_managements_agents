# Data Warehouse — Connection Methodology

**Purpose:** Pattern for connecting Python scripts to a SQL data warehouse (Trino / Starburst / Snowflake / BigQuery / Postgres / Presto). Covers credential hygiene, connection scripting, and common pitfalls.

---

## Credential hygiene

**Never commit credentials to the repo.** Three acceptable places to store them:

| Method | When to use | Retrieval |
|---|---|---|
| **macOS Keychain** | Local dev on a single machine. Credentials stay encrypted at rest. | `security find-generic-password -s "<service-name>" -w` |
| **.env file** | Cross-platform dev. Store in project root, gitignored. | `python-dotenv` or `os.environ.get()` |
| **Vault / secret manager** | Team or production use. Central source of truth. | Vendor-specific client (HashiCorp Vault, AWS Secrets Manager, etc.) |

Never hardcode credentials in Python files. Never paste them into chat.

### Example: storing in macOS Keychain
```bash
security add-generic-password -a "your.username" -s "trino-prod" -w "your-password"
```

### Example: reading from Keychain in Python
```python
import subprocess
password = subprocess.check_output(
    ["security", "find-generic-password", "-s", "trino-prod", "-w"]
).decode().strip()
```

---

## Connection script pattern

Keep the connection script minimal and reusable. One function that returns a connected cursor:

```python
from trino.dbapi import connect  # or: snowflake.connector, psycopg2, etc.

def get_connection():
    return connect(
        host="your-warehouse-host.example.com",
        port=443,
        user="your.username",
        password=_read_password_from_keychain("trino-prod"),
        http_scheme="https",
        catalog="hive",   # or your default catalog
        schema="default",
    )

def run_query(sql, params=None):
    with get_connection().cursor() as cur:
        cur.execute(sql, params or {})
        return cur.fetchall(), [d[0] for d in cur.description]
```

All other scripts import this module. Never re-implement connection logic.

---

## Gotchas (common across warehouses)

### Query dialect differences
Trino vs Hive vs Presto vs Snowflake all have subtle differences:
- JSON extraction: `json_extract_scalar()` (Trino) vs `get_json_object()` (Hive)
- Date casting: `DATE '2026-04-21'` (Trino) vs `'2026-04-21'::date` (Postgres)
- String functions: `TRIM()` behavior varies on non-string types

Always verify the dialect before writing queries. When in doubt, the engine's own docs.

### Partition filters are mandatory in many setups
Large tables often require partition filters (`dl_last_updated = DATE 'YYYY-MM-DD'`, `ingest_date = ...`). Queries without them may be rejected or silently scan the whole table. Check the target table's documentation.

### Network requirements
Internal warehouses often require VPN or corporate network. Verify reachability before debugging query logic:
```bash
nc -zv warehouse-host.example.com 443
```

### Row count caps
Most warehouses cap result sets (65,536 rows is common). Use `LIMIT` for exploration, `GROUP BY` / aggregation for production queries.

### Type surprises
Don't assume column types. Run `DESCRIBE <table>` first. Casting string columns that look numeric without verifying causes silent wrong results.

---

## Credential rotation

If your warehouse uses short-lived credentials (SSO tokens, expiring passwords):
- Document the rotation cadence in a local note
- Script should fail fast with a clear message when credentials expire, not retry silently
- Don't log passwords or tokens (redact in any error output)

---

## Getting access (for new PMs)

Most enterprise warehouses require an access ticket through a platform/data team. Typical ask includes:
- Your user identifier
- Which databases / schemas you need read access to
- Write access (if applicable) — usually requires a stronger justification
- IP allowlist (if warehouse is IP-restricted)

Track the ticket in your workspace so the next PM inheriting the product knows what access level you have.

---

## Security notes

- `credentials.json` / `.env` / any secret file must be in `.gitignore` BEFORE first commit
- Review `git log` to verify nothing sensitive was committed historically
- Treat connection logs carefully — they can leak table names and query patterns that are sensitive even without data
- Use read-only credentials wherever possible; ask for write access only for specific use cases
