# DukaanFlow prototype

A self-contained merchant dashboard prototype with a small Node.js API. It uses fictional seed data for Sri Lakshmi Stores and persists order drafts and reminder drafts in `data.json`.

## Run locally

Install Node.js 18 or newer, then from this folder run:

```sh
npm start
```

Open <http://localhost:4173>. Set the `PORT` environment variable to use a different port.

## API

- `GET /api/health` — server status
- `GET /api/dashboard` — merchant summary and decision inputs
- `GET /api/products` and `GET /api/customers` — seeded records
- `GET /api/orders` — saved draft orders
- `POST /api/ask` with `{ "question": "Can I buy ₹20,000 of stock?" }`
- `POST /api/orders` with `{ "productId": "milk-500" }` (uses its suggested quantity)
- `POST /api/reminders/draft` — prepare customer reminder drafts; it does not send messages

The responses use transparent demo rules and the local seed data. No bank, UPI, supplier, WhatsApp, or AI model integration is configured.
