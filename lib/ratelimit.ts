import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// 1 Deepgram token per user per 30 seconds (prevents parallel call abuse)
export const callStartLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, "30 s"),
  prefix: "rl:call",
});

// 20 chat/TTS requests per user per minute
export const chatLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, "60 s"),
  prefix: "rl:chat",
});

// 100 general API requests per user per minute
export const apiLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(100, "60 s"),
  prefix: "rl:api",
});

// 10 requests per IP per minute — /api/warmup-db is unauthenticated (it's a
// health/pre-warm ping), so this is keyed by IP rather than user id.
export const warmupLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "60 s"),
  prefix: "rl:warmup",
});
