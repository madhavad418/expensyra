# Security Notes

## Secrets

`PLEO_API_KEY` is read only by the backend process from environment variables. The API status endpoint returns only whether a key is configured and a masked company ID. It does not return the key.

Never put the production key into:

- `public/app.js`;
- browser local storage;
- Git/GitHub;
- `.env.example`;
- support screenshots;
- chat/email threads;
- logs.

## Pleo access

Use a dedicated Standalone API Key with the minimum read scopes required by the configured connector. Rotate the key if exposure is suspected.

## Application authentication

- Passwords are stored as salted `scrypt` hashes.
- Session IDs are random and only their SHA-256 hashes are stored in SQLite.
- Session cookie is `HttpOnly` and `SameSite=Lax`.
- Set `COOKIE_SECURE=true` behind HTTPS.
- Administrator-created users are forced to change the temporary password before accessing the application.
- Creating the first administrator is possible only when there are no users in the database.

## Authorisation

Every protected API route checks the authenticated role. Reviewers see only their assigned transactions. Receipt endpoints use the same transaction-level access rule.

## Receipts

Cached receipts are written under `ATTACHMENT_DIR` with restrictive file creation mode. Protect the persistent volume and its backups as confidential finance data.

## Recommended production controls outside the package

For company production deployment, place Expensyra behind JSAN's standard identity/network layer where practical. Recommended additions for the organisational rollout include:

- Microsoft Entra ID/SSO to replace local Phase-1 accounts;
- managed WAF/reverse proxy and HTTPS;
- central log/alert collection;
- vulnerability/dependency/container scanning;
- formal backup/restore procedure;
- access review for admins/team leads;
- internal security review before broad rollout.

## SQLite deployment boundary

Use one application replica with one persistent database volume. Do not copy the database into multiple independently writable replicas.
