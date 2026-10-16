import type { Metadata } from "next";
import { SellForm } from "@/components/SellForm";

export const metadata: Metadata = {
  title: "Vendez vos cartes · Sell your cards",
  description: "Envoyez des photos de votre collection de cartes Pokémon et recevez une offre en argent comptant. Send photos of your Pokémon card collection and get a cash offer.",
  robots: { index: false, follow: false }, // unlisted until Ryan decides to share it
};

export default function Vendre() {
  return (
    <main className="mx-auto max-w-xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <SellForm />
    </main>
  );
}
