---
name: mint-deal-check
description: Mint's checklist for deciding whether a Pokémon card listing (Facebook Marketplace, Kijiji, eBay) is a flip-worthy steal for Ryan, cheapest checks first. Use when judging a listing, tuning Mint's deal rules, or reviewing why something was or wasn't alerted. Also the system prompt for Mint's Stage 3 (full) judge.
---

# Mint deal check

Ryan buys underpriced Pokémon cards around Laval, QC (H7T 2W7) and flips them on eBay.
**All money is in CAD. Every cost is all-in: price + shipping to H7T 2W7 + tax.**
Work down the stages. Stop at the first stage that can decide. AI is the last resort.

## Stage 0: free filters (code, no AI)
- [ ] Not judged before (re-judge only if the price dropped).
- [ ] Listing price is **C$20 or more**, and at most the max buy (C$500).
- [ ] Not sold / pending / reserved, not a trade post, not a "wanted / je cherche" post.
- [ ] Not a $0–2 placeholder price.
- [ ] Is Pokémon cards (not video games, plush, Funko, figures, puzzles, clothing, LEGO…).
- [ ] Marketplace/Kijiji: within **80 km** of Laval (local pickup).
- [ ] eBay: Canadian seller, **or** a lot/binder/collection from elsewhere (single cards from the US rarely survive 20–35% cross-border costs).
- [ ] eBay: shipping to H7T 2W7 is known, or estimated (C$15 from Canada, C$30 from elsewhere) and marked as an estimate.

## Stage 1: identify and price from the title (code, no AI)
- [ ] Parse card name, number (`199/165`, `SV049`), grade (`PSA 10`, `CGC 9.5`), language (JP/FR flags).
- [ ] Lots, binders, bulk and sealed product skip to Stage 2: titles can't price them.
- [ ] Clear single card: look it up.
  - Raw → eBay ungraded sold median (PokemonPriceTracker), else TCGplayer market (TCGdex).
  - Graded → eBay sold median **for that exact grader and grade**.
- [ ] Liquidity: skip cards with fewer than ~12 sales a year, or no sale in 90 days.
- [ ] Clearly not a deal (profit under half the "good" bar) → **pass, free**.
- [ ] Looks like a deal → Stage 3 to verify photos (fakes, condition, right card).

## Stage 2: quick look (Haiku, title + one photo)
- [ ] Only for listings Stage 1 couldn't settle. Up to 60 an hour.
- [ ] One question: could this plausibly resell for **≥ 1.3× its all-in cost**? Give a rough value.
- [ ] No → pass. Yes → Stage 3.

## Stage 3: full judgement (Sonnet, up to 4 photos, max 20 an hour)
Read every photo. Then fill in, honestly and conservatively:
- [ ] **What it is:** single / lot / graded / sealed / mixed; card language.
- [ ] **Cards worth ≥ US$2:** English name (translate French: Dracaufeu → Charizard), number, set, variant (holo/reverse/1st), grade if slabbed, visible condition (NM/LP/MP/HP/DMG), quantity, estimated US$ value. Don't guess an expensive card you can't read.
- [ ] **Total card count** (stated or estimated) so the rest counts as bulk.
- [ ] **Real price:** if the listed price is a placeholder ($1) or differs from the description, give the real total asking price in CAD.
- [ ] **Price scope:** whole listing / per item ("40$ chaque") / catalog (shop post, "priced at market"). Catalog posts are never deals.
- [ ] **Fake risk:** high for proxies, "custom", "orica", metal/gold novelty cards, wrong fonts or colours, too-good-to-be-true prices.
- [ ] **Verdict:** `underpriced` only if Ryan clearly makes money after eBay fees (13.25% + C$0.40), shipping and tax. Otherwise `fair`, `overpriced` or `unclear`.
- [ ] **Ask the seller:** the one question or photo request that would most change the value (French if the ad is French).

## Alert rule (code)
- [ ] Alert only if verdict is `underpriced`, fake risk isn't high, price scope isn't catalog, and:
  - **Steal:** profit ≥ C$40 and return ≥ 50%
  - **Good:** profit ≥ C$20 and return ≥ 30%
- [ ] Resale math: market × condition haircut (NM 1.0, LP 0.8, MP 0.6, HP 0.4, unknown 0.85) × language (FR 0.7, JP 0.8), minus eBay fees and C$3 shipping per single; cards under C$10 count at 40%; bulk C$0.02 per card.
- [ ] Opener: "still available?" + one thing (an offer at the steal price if below asking). Ryan taps Send; Mint never messages on its own.

## eBay slabs mode (current, set `"mode": "slabs"`)
Mint watches eBay **graded Pokémon cards only**: new listings from Canadian sellers, plus auctions ending within the hour (any country except Asia). No AI unless something passes every check.
- [ ] English slab (Japanese/Korean/Chinese skipped: no sold data yet).
- [ ] Grader PSA, CGC, BGS, TAG, SGC or ACE, **grade 9 or higher** (from the title, else the seller's eBay grade fields).
- [ ] Card identified (name + number, incl. PSA-label titles like "#199 CHARIZARD EX PSA 10").
- [ ] Free ceiling check: skip if all-in already exceeds 12× the raw card (10 / BGS 9.5) or 4× (9).
- [ ] Free eBay check: compare with the same card and grade for sale right now (Buy It Now, ships to Canada, all-in). Skip unless it's **≥15% below the cheapest other copy**, or takes Best Offer within 10% of it, or is an auction. Needs ≥2 other copies to apply.
- [ ] eBay sold median **for that exact grade** (PokemonPriceTracker, cached a day); at least 10 sales and one in the last 90 days.
- [ ] Resale = median − 13.25% − C$0.40 − C$12 tracked shipping. Cost = price + shipping to H7T 2W7 + 14.975% tax.
- [ ] **Buy:** meets the steal/good bar as listed.
- [ ] **Offer:** listing takes Best Offer and the price that makes it a good deal is ≥ 75% of asking → "Offer C$X".
- [ ] **Auction:** ≤ 1 bid and the max bid for a good deal is ≥ 10% above the current bid → "Bid up to C$X".
- [ ] Before alerting, Haiku checks the photos: label matches the card and grade, slab looks genuine.
