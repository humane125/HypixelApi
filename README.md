# Hypixel SkyBlock Auction Service

Local Node.js service for scanning Hypixel SkyBlock BIN auctions, searching Final Destination armor, and calculating a suggested listing price for a future Minecraft mod.

## Run

```powershell
node server.js
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

Create or update `.env` only if you want to protect the service:

```text
AUCTION_API_TOKEN=optional_shared_token
PORT=3001
```

- A Hypixel API key is not needed for the current auction endpoints used by this service.
- `AUCTION_API_TOKEN` protects this service's API endpoints. If unset, anyone who can reach the server/ngrok URL can call the APIs.

## Web UI

Open the local server URL or hosted/ngrok URL in a browser. Use:

1. `Refresh Index` to load current BIN auctions.
2. `Search` to find matching listings.
3. `Recommend BIN` to calculate a suggested listing price.

The current pricing flow is tuned for Final Destination armor around 25k kills.

## API Docs

See [docs/API.md](docs/API.md).
