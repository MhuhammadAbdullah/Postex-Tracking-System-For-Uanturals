# PostEx order tracking for UANaturals

The server exposes two customer-facing routes:

- `GET /api/track?tracking=CX-...` looks up a PostEx tracking number.
- `GET /api/track-order?orderNumber=...&customer=...` matches the PostEx `orderRefNumber` with either `deliveryAddress` (email) or `customerPhone` and returns limited tracking details.

PostEx's guide does not provide a direct order-reference lookup. The second route uses `get-all-order` across `2000-01-01` through today and checks the exact order number and email on the server. The guide does not specify whether PostEx limits this date range or result size; if their API limits it, older orders may need a date/index strategy confirmed with PostEx support.

## Configure

Set `MY_POSTEX_TOKEN` in the hosting provider's secret/environment settings. Never place the token in browser code or commit it. The token pasted in the request should be rotated in the PostEx merchant panel, then the replacement saved as `MY_POSTEX_TOKEN`.

Optional: set `ALLOWED_ORIGINS` to a comma-separated list of storefront origins. The default is `https://www.uanaturals.com,http://localhost:3000`.

For local development, copy `.env.example` to `.env` and add the token. `.env` is ignored by Git.

## Storefront widget

Copy `public/tracking-widget.html` into a Shopify Custom Liquid block where the tracking form should appear. It includes the order-number + email/phone and tracking-number tabs. It calls the deployed API host configured in the widget's `api` constant; update that URL if the backend deployment hostname changes.
