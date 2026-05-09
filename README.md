# xlsx-for-ai-site

Static one-page site for [xlsx-for-ai.dev](https://xlsx-for-ai.dev).

Deployed via GitHub Pages from `main`.

## Sections

- Hero / pitch
- Features grid
- Free-to-start CTA (no published pricing yet — early-access via contact email)
- Quick start
- Contact
- Terms of Service
- Privacy Policy
- Refund Policy

All on one page with fragment links — Stripe-acceptable for verification.

## Deploy

1. Push to `senoff/xlsx-for-ai-site` on GitHub.
2. Settings → Pages → Source: `main` / `/` (root).
3. Custom domain: `xlsx-for-ai.dev`.
4. At GoDaddy DNS:
   - Remove the GoDaddy Website Builder records.
   - Add `A` records pointing to GitHub Pages IPs (`185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`).
   - Add `CNAME` for `www` → `senoff.github.io`.
5. Wait for DNS + cert provisioning (≤ 1 hour).

## Edit

Single file: `index.html`. Inline CSS, no build step.
