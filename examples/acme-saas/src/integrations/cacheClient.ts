import { createClient } from "redis";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

export const cacheClient = {
  topic(name: string): string {
    return `cache:${name}`;
  },

  async publish(channel: string, payload: unknown): Promise<void> {
    const client = createClient({ url: redisUrl });

    try {
      await client.connect();
      await client.publish(channel, JSON.stringify(payload));
    } finally {
      await client.disconnect();
    }
  }
};
