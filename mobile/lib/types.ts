export type Call = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  creditsUsed: number;
  status: string;
  platform: string;
};

export type CreditTransaction = {
  id: string;
  type: string;
  credits: number;
  balanceAfter: number;
  description: string | null;
  createdAt: string;
};

export type User = {
  id: string;
  email: string;
  name: string | null;
  role: string;
};

export type Session = {
  token: string;
  user: User;
};
