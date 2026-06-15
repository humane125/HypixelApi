# Hypixel SkyBlock Auction Service

Local Node.js service for scanning Hypixel SkyBlock BIN auctions, searching Final Destination armor, and calculating a suggested listing price for a future Minecraft mod.

## Install

```powershell
npm install
```

## Build the React UI

```powershell
npm run build
```

The React app builds into `public/`, which is served by the Node API server.

## Run

```powershell
npm start
```

Default URL:

```text
http://localhost:3000
```

Current hosted/ngrok URL:

```text
https://lazy-similarly-reaffirm.ngrok-free.dev/
```

Set a custom port:

```powershell
$env:PORT='3001'
node server.js
```

## Environment

Create or update `.env`:

```text
OWNER_API_KEY=hpx_live_your_private_owner_key
DASHBOARD_USERNAME=owner
DASHBOARD_PASSWORD=change_this_password
PORT=3001
DATABASE_PATH=data/app.db
DASHBOARD_COOKIE_SECURE=true
```

- A Hypixel API key is not needed for the current auction endpoints used by this service.
- `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` seed the first owner dashboard login.
- If no dashboard login is configured and the database has no password users, the server generates a first-run dashboard password and prints it once in the server console.
- `OWNER_API_KEY` seeds the first owner API key in the database. `AUCTION_API_TOKEN` still works as a backwards-compatible bootstrap key for API clients.
- If no owner token is configured and the database has no API keys, the server generates a first-run owner API key and prints it once in the server console.
- API keys are stored hashed in SQLite. The raw key is only shown when it is created.
- `DATABASE_PATH` defaults to `data/app.db`.
- `DASHBOARD_COOKIE_SECURE=true` forces dashboard cookies to use the `Secure` flag. The server also enables it automatically when `X-Forwarded-Proto: https` is present, which ngrok commonly sends.
- Dashboard login has in-memory throttling for repeated failed username/password attempts. Restarting the server clears the throttle state.

## Web UI

Open the local server URL or hosted/ngrok URL in a browser.

The React UI has two views:

- `Auctions`: refresh/search Hypixel auctions and calculate BIN recommendations.
- `Dashboard`: register Minecraft accounts, manage dashboard users, issue/revoke API keys, and update account status.

Use your dashboard username/password to access `Dashboard`.

Dashboard roles:

- `owner`: create/delete dashboard users, assign roles, manage API keys, and create/update/delete Minecraft accounts.
- `manager`: create/update Minecraft accounts.
- `viewer`: view dashboard data only.

Minecraft account cards use Mineatar face renders from:

```text
https://api.mineatar.io/face/<uuid>
```

Use API keys for:

- Minecraft mod authentication.
- Auction API requests.
- External scripts or tools that call `/api/*`.

API keys can only be assigned to existing dashboard users. Create the dashboard user first, then choose that user when creating the key.

For the auction view:

1. `Refresh Index` to load current BIN auctions.
2. `Search` to find matching listings.
3. `Recommend BIN` to calculate a suggested listing price.

## API Docs

See [docs/API.md](docs/API.md).

## Test

```powershell
npm test
```
