# Rebound Radar — launch-ready free beta package

This package preserves the recovered Rebound Radar HTML design, stock scanner demonstration, local watchlist, embedded chart integrations, and CSV history checker. It is a **static research beta, not a complete paid stock recommendation service**.

## What's deliberately disabled

- The unconfigured Clerk development publishable key has been removed. No login or cloud account persistence is offered.
- No paid checkout, subscriptions, recurring billing, actual delivered alerts, or daily stock-pick automation is enabled.
- Stock prices, news reasons, and rebound scores are demonstration records; the UI visibly says so.

## Host for free on GitHub Pages

1. Create a **new dedicated repository** such as `rebound-radar` (do not reuse or disturb the existing FWB WORLD CUPS or BuildABuddy repositories).
2. Upload `index.html`, `.nojekyll`, `404.html` and `.github/workflows/pages.yml` to the new repository.
3. In the new repository Settings → Pages, set Source to **GitHub Actions**.
4. Run/approve the pages workflow, confirm it is covered by included usage, and verify its deployed URL on a mobile phone and desktop.
5. Confirm demo banner, scanner filters, chart links, local watchlist, CSV import, and that no account or billing flow is exposed.

`index.html` can also be served without build tools by any ordinary static host. Open it locally, or use `python3 -m http.server 8000` from this directory.

## Before launch as a paid research platform

- Verified licensed stock feed, timestamps and scoring/backtest methodology.
- Secure production sign-in/account backend and privacy policy.
- Automated weekday publishing, alerts, audit logs, correction and performance tracking.
- AI-company intelligence reports with sources, risk discussion and legal/financial publishing review.
- Tested Stripe subscriptions, entitlements, refunds/cancellations, monitoring and fraud controls.

**Vision and planned pricing:** Free; Pro $9.99/month ($99/year), 5 weekday research candidates; Premium $19.99/month ($199/year), 10 candidates and deeper AI-company research. The paid services are *planned*, not active in this release.

No paid products, domains, or external subscriptions are required for this beta package.
