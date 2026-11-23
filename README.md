# Dupe Finder

A Cloudflare Pi agent that looks up a beauty product page and compares it with a small curated India skincare catalog.

## Run locally

```powershell
npx wrangler login
npm run dev
```

Open http://localhost:8787 and paste a product link or an ingredient list. Wrangler uses the local Durable Object and the remote Workers AI binding.

## Current MVP scope

- The agent fetches the submitted HTTPS product page when the retailer allows it.
- It tries to extract the product name, listed price, package size, ingredient list, and stated active ingredients.
- It ranks candidates by active-ingredient overlap and full ingredient overlap, and flags cheaper candidates using price per ml/g when possible.
- When an ingredient list cannot be extracted, it gives the user a manual INKEEDecoder product-search link, then compares the ingredient list the user pastes against the fetched candidate ingredients.
- The app does not scrape or reuse INKEEDecoder database content: its Terms of Service prohibit data mining and copying/reuse without permission.
- The curated catalog has four cleansers, four moisturizers, and two serums from the supplied guide. Its prices are approximate, and the ingredients are key ingredients only, not full INCI lists. The two serum entries are the only serum products supplied so far.

## Notes

The comparison is informational. Shared ingredients do not mean two formulas have the same concentration, performance, or suitability. Retail pages may block automated fetches or change their markup; in those cases, paste the ingredient list into the chat.


