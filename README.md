<div align="center">

# CardThief

**A tool that watches online listings for Pokémon cards that are priced well below what they're worth.**

<!-- facts --><img alt="Watches: eBay, Kijiji, Facebook" src="https://img.shields.io/badge/Watches-eBay,_Kijiji,_Facebook-24292f?style=for-the-badge"> <img alt="Scans: as often as every min" src="https://img.shields.io/badge/Scans-as_often_as_every_min-24292f?style=for-the-badge">

</div>

<br>

It runs on a home computer and keeps checking Kijiji, Facebook Marketplace and eBay for new Pokémon card listings in and around Montréal. For each one, it filters out obvious junk, estimates what the cards are worth using recent prices, and uses AI (a computer program that can read text and photos) to judge whether the listing is a real bargain. When it finds one, it sends an alert to my phone. I built it for my own card buying, and it is private, not a public service.

## What it does

- Checks several marketplaces every few minutes for new Pokémon card listings.
- Skips listings that are too far away to pick up, already sold, "wanted" posts, or not actually cards.
- Estimates a card's or a whole collection's value and flags listings priced well under that.
- Sends phone alerts for good deals, shown in a companion app with buttons to message the seller, pass, or mark a card as bought or sold.
- Values a pile of cards from photos: snap a binder or a seller's pictures and get a price estimate for the whole lot.
