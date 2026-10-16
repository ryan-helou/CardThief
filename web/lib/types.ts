// A deal as the Mac bot sends it (src/run.mjs → POST /api/agent/deal).
export interface DealLine {
  label: string;
  marketCad: number;
  netCad: number;
  basis: string;
}

export interface Deal {
  gone?: string; // why the Mac closed it (listing sold or ended, local alert a week old)
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
  compsQueries?: string[];
  action?: "buy" | "offer" | "auction" | "ask";
  grade?: string | null;
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

export interface Slim {
  at: string; source: string; title: string; url: string; photo: string | null;
  tier: string; stage: number; price: number | null; profit: number; roi: number; why: string;
}

export interface Report {
  today?: {
    found: number; skipped: number; judged: number; deals: number;
    stages: Record<string, number>;
    bySource: Record<string, { found: number; skipped: number; judged: number; deals: number }>;
    reasons: Record<string, number>;
  };
  week?: { day: string; found: number; judged: number; deals: number }[];
  nearMisses?: Slim[];
  outcomes?: Outcome[];
  recent?: Slim[];
  budgets?: { pptLeft: number; pptMax: number; ebayCalls: number; ebayMax: number; messages: number; messagesMax: number };
  sources?: Record<string, { on: boolean; every?: number; mode?: string; hours?: number[]; active?: boolean }>;
  rules?: Record<string, unknown> & {
    steal?: { minProfitCad: number; minRoi: number }; good?: { minProfitCad: number; minRoi: number };
  };
  queueBySource?: Record<string, number>;
  startedAt?: string;
}

export interface Heartbeat extends Report {
  at: string;
  kijiji?: string; // last successful poll
  ebay?: string | null;
  facebook?: string | null;
  queue?: number;
  judgedToday?: number;
  dealsToday?: number;
  lastError?: string | null;
}

// What happened to an eBay alert after it was sent (checked every 15 minutes for 14 days).
export type Outcome = {
  id: string; title: string; url: string; price: number; profit: number;
  alertedAt: string; status: "live" | "sold" | "ended" | "gone";
  minutesAfterAlert?: number; minutesAfterListing?: number;
};
