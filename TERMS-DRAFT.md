# Terms of Service — DRAFT v0

**Status:** draft for Bob's review. NOT YET PUBLISHED. Once approved, will be hosted at https://xlsx-for-ai.dev/terms as part of connector-submission prep (Anthropic Connectors Directory + Microsoft Partner Center).

**Drafted to satisfy:** Anthropic Software Directory Terms requirements (developer commitments — acceptable use, no malware, support obligation) and Microsoft Commercial Marketplace certification policy 1140.9 (IP, taxonomy, support, privacy, content guidelines).

**Style alignment:** matches `PRIVACY.md` voice — plain English, no jargon, auditable.

---

# Terms of Service

**Effective date:** _[TBD on publish]_
**Last updated:** _[TBD on publish]_

These Terms of Service ("Terms") govern your use of the xlsx-for-ai software, the hosted API at `api.xlsx-for-ai.dev`, the npm package `xlsx-for-ai`, the MCP server, and any related services (collectively, "the Service"). By using the Service you agree to these Terms.

If you do not agree, do not use the Service.

---

## 1. Description of the Service

xlsx-for-ai provides reliable access to Excel (.xlsx) files for AI agents. It includes:

- A hosted HTTPS API for reading, writing, diffing, validating, and analyzing .xlsx files.
- An npm-published client (`xlsx-for-ai`) that an agent invokes to call the API.
- A Model Context Protocol (MCP) server that exposes tools to MCP-compatible agents and clients.

The Service is operated by an individual developer ("we"). All data handling is described in our [Privacy Policy](/privacy), which is incorporated into these Terms by reference.

---

## 2. Eligibility and account types

The Service offers a Free tier and paid tiers (Bronze, Silver, Gold).

The Free tier registers an anonymous `client_id` on first use. No email address, name, or other identifying information is required. By using the Free tier you confirm you are at least 13 years old and legally able to enter into these Terms in your jurisdiction.

Paid tiers may require additional information (billing details, business identification). Paid tier terms — call quotas, billing cadence, refund policy — are documented at the time of purchase and incorporated into these Terms by reference.

---

## 3. Acceptable use

You may use the Service to read, write, analyze, and transform .xlsx files in your own workflows or in workflows you operate on behalf of users who have authorized you to do so.

You agree to:

- Use the Service in compliance with applicable laws and regulations in your jurisdiction.
- Respect rate limits and quotas associated with your tier.
- Provide accurate information when required (e.g., billing details on paid tiers).
- Not attempt to access, probe, or test the vulnerability of the Service except as expressly authorized in our [Security Policy](https://github.com/senoff/xlsx-for-ai/blob/main/SECURITY.md).

---

## 4. Prohibited use

You may not use the Service to:

- Violate any law, regulation, or third party's rights.
- Process, transmit, or store content that is illegal, infringing, or that you do not have the right to process.
- Distribute malware, conduct denial-of-service attacks, attempt to gain unauthorized access to any system, or otherwise harm the Service or its other users.
- Reverse engineer, decompile, or otherwise attempt to derive the source code of any server-side component, except to the extent such restriction is prohibited by applicable law.
- Resell, sublicense, or redistribute API access as a standalone offering. (You may incorporate the Service's outputs into your own product or workflow; the prohibition is on reselling API access itself.)
- Use the Service to train competing machine learning or AI models without prior written consent.
- Submit files larger than the maximum size for your tier, or in formats not supported.
- Misrepresent your identity, your tier, or the source of your usage.

We may suspend or terminate access for violations of this section. We will make reasonable efforts to provide notice before termination unless the violation poses an immediate risk to the Service or its users.

---

## 5. Data handling

Data handling is governed by our [Privacy Policy](/privacy). Key points:

- File bytes leave your machine and are processed in memory on our server for non-fallback tool calls.
- File bytes are not persisted in normal (non-error) operation.
- Error-triggered capture, if enabled, retains redacted copies (cell values stripped, structure preserved) for up to 30 days for engine debugging — not for training, not for third-party sharing.
- You can opt out of capture per-request, per-session, or globally. See the Privacy Policy for details.
- Audit logs (request metadata, not workbook content) are retained for 90 days.

You retain all rights to your .xlsx file content. We do not claim ownership of any file you submit through the Service.

---

## 6. Intellectual property

The Service — including the API, the MCP server implementation, the npm client, documentation, brand assets, and any other materials we provide — is owned by us and protected by intellectual property laws. The npm client (`xlsx-for-ai`) is licensed under the MIT License; see the LICENSE file in the package for terms. Server-side components are proprietary unless their license states otherwise.

You retain all rights to:

- Your .xlsx file content.
- Any outputs the Service produces from your file content (e.g., diffs, summaries, transformed files).

We grant you a non-exclusive, non-transferable license to use the Service in accordance with these Terms. No other license is granted, express or implied.

---

## 7. Third-party components and services

The Service uses third-party software components and services, including but not limited to:

- Hosting infrastructure (Fly.io).
- Database and caching services (PostgreSQL, Redis).
- Optional AI model providers (Anthropic) for narrow internal classification tasks. See the Privacy Policy for the specific surfaces and data scope.

Use of third-party components is governed by the terms of their respective providers in addition to these Terms.

---

## 8. Service availability

We aim for high availability but do not guarantee uninterrupted access. The Service may be unavailable due to maintenance, infrastructure issues, or other factors. Where a tier-specific Service Level Agreement is offered, it is published at the time of purchase and supersedes this section for that tier.

For free-tier users, the Service is provided on an as-is, best-effort basis.

---

## 9. Modifications to the Service

We may add, change, or remove features at any time. For changes that materially affect existing paid-tier users, we will provide reasonable advance notice. Free-tier features may change without notice.

---

## 10. Termination

You may stop using the Service at any time. For Free-tier users, deletion is described in the Privacy Policy. For paid-tier users, termination procedures are documented at the time of purchase.

We may suspend or terminate your access if you violate these Terms, if continued access poses a security or legal risk, or if we discontinue the Service. Where reasonable, we will provide advance notice and allow time to retrieve any data you have stored.

---

## 11. Disclaimer of warranties

The Service is provided "as is" and "as available," without warranties of any kind, express or implied. We disclaim all warranties including, without limitation, warranties of merchantability, fitness for a particular purpose, non-infringement, and any warranties arising from course of dealing or trade usage.

We do not warrant that the Service will be uninterrupted, error-free, secure against all threats, or that defects will be corrected. You assume all risk arising from your use of the Service.

Some jurisdictions do not allow exclusion of certain warranties; the above exclusions apply only to the extent permitted by applicable law.

---

## 12. Limitation of liability

To the maximum extent permitted by applicable law:

- Our total liability arising out of or related to these Terms or the Service shall not exceed the greater of (a) the amount you paid us for the Service in the twelve months preceding the event giving rise to the claim, or (b) one hundred US dollars (USD 100).
- We shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including without limitation lost profits, lost data, business interruption, or loss of goodwill, even if advised of the possibility of such damages.

Some jurisdictions do not allow exclusion of certain damages; the above limitations apply only to the extent permitted by applicable law.

---

## 13. Indemnification

You agree to defend, indemnify, and hold us harmless from any claims, damages, liabilities, and expenses (including reasonable attorneys' fees) arising out of or related to your use of the Service in violation of these Terms, your violation of any third party's rights, or your violation of any applicable law.

---

## 14. Governing law and disputes

These Terms are governed by the laws of the State of Texas, USA, without regard to its conflict-of-laws principles. Any dispute arising out of or related to these Terms or the Service shall be brought in the state or federal courts located in Travis County, Texas, and you and we consent to the personal jurisdiction of those courts.

If any provision of these Terms is held invalid or unenforceable, the remaining provisions remain in full force.

---

## 15. Changes to these Terms

We may modify these Terms from time to time. Material changes will be noted with the date they take effect. Continued use of the Service after the effective date constitutes acceptance of the modified Terms. For paid-tier users, we will provide reasonable notice of material changes.

---

## 16. Contact

For questions about these Terms, support requests, or to report a violation:

- Email: `support@xlsx-for-ai.dev`
- Security reports: see [SECURITY.md](https://github.com/senoff/xlsx-for-ai/blob/main/SECURITY.md)
- Privacy inquiries: `hello@xlsx-for-ai.dev`

---

## Notes for Bob's review

Items that need your explicit decision before this goes live:

1. **Governing law / venue (§14)** — I defaulted to **Texas / Travis County**. If your residency or LLC is elsewhere, swap. (Common alternatives: Delaware if you have a Delaware LLC; California if SF Bay-based.)

2. **Liability cap (§12)** — set at **greater of (last 12 months paid) or USD 100**. This is standard for solo-dev SaaS. Lower cap (USD 50 or USD 0) is defensible for free-tier-only users; higher caps invite real liability exposure. Suggest leaving as-is.

3. **Effective date** — fill in at publish time.

4. **"At least 13 years old" (§2)** — COPPA-style minimum. Some products use 16 (GDPR) or 18 (more conservative). 13 is the most permissive and common for developer tools.

5. **Paid-tier terms** — §2 and §10 reference "documented at the time of purchase." When Bronze/Silver/Gold tiers ship, those terms get added (refund window, billing cadence, cancellation flow).

6. **Indemnification scope (§13)** — narrow form (only for user-side violations). Could go broader but no reason to.

7. **Resale prohibition (§4)** — distinguishes "use the outputs in your product" (allowed — that's the whole point) from "resell API keys as a standalone offering" (banned). Lets agent platforms / wrappers build on top without resellers undercutting the tier model.

8. **Train-competing-models prohibition (§4)** — boilerplate; standard for AI-adjacent services. Doesn't block normal agent workflows.

**Not surfaced in this doc but consider:**

- A separate **DPA (Data Processing Addendum)** if enterprise customers ever sign on. Out of scope for v0.
- **Sub-processor list** — currently in Privacy. Could be moved to a dedicated `/subprocessors` page if requested.
- **Export-control statement** — not included; can be added if a compliance reviewer asks.

After your review: I'll convert this Markdown to HTML, host at `/terms`, and update the spec status. Per the connector-submission spec, this needs to land before the Anthropic submission goes in front of Anthropic's reviewer.
