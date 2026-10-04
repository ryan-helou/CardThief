// A deal as the Mac bot sends it (src/run.mjs → POST /api/agent/deal).
export interface DealLine {
  label: string;
  marketCad: number;
  netCad: number;
  basis: string;
}

export interface Deal {
  id: string; // "kijiji:123" | "ebay:456"
  source: "kijiji" | "ebay" | "facebook";
  url: string;
  title: string;
  photo?: string;
  location?: string;
  postedAt?: string;
  foundAt: string;
  price: number;
  shipping?: number;
  cost: number; // all-in to buy
  resale: number; // net after eBay fees + shipping
  profit: number;
  roi: number;
  tier: "steal" | "good";
  kind?: string;
  fakeRisk?: "low" | "medium" | "high";
  fakeReasons?: string;
  lines: DealLine[];
  summary?: string;
  hiddenUpside?: string;
  askSeller?: string;
  offer?: number;
  draft?: string; // opener the bot can send for Ryan
  bids?: number | null;
  endsAt?: string | null;
  seller?: string;
}

export type Status = "new" | "bought" | "sold" | "passed";

export interface Message {
  text: string;
  state: "queued" | "sent" | "failed";
  at: string;
  error?: string;
}

export interface DealRow {
  deal: Deal;
  message: Message | null;
  status: Status;
  boughtFor: number | null;
  soldFor: number | null;
  updatedAt: string;
}

export interface Heartbeat {
  at: string;
  kijiji?: string; // last successful poll
  ebay?: string | null;
  facebook?: string | null;
  queue?: number;
  judgedToday?: number;
  dealsToday?: number;
  lastError?: string | null;
}
