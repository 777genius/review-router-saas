import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const appProfileSchema = z.object({
  APP_ID: z.coerce.number().int().positive(),
  APP_CLIENT_ID: z.string().min(1).optional(),
  APP_SLUG: z.string().min(1).optional(),
  APP_NAME: z.string().min(1).optional(),
  APP_PRIVATE_KEY_FILE: z.string().min(1),
});

export type AppProfile = z.infer<typeof appProfileSchema> & {
  privateKey: string;
  profilePath: string;
};

export function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return input;
}

export function loadEnvFiles(): void {
  dotenv.config({ path: '.env.local', override: false });
  dotenv.config({ path: '.env', override: false });
}

export function loadAppProfile(profileArg = process.env.REVIEW_ROUTER_APP_PROFILE): AppProfile {
  const defaultPath = '~/.config/review-router/apps/review-router-ai.env';
  const profilePath = expandHome(profileArg || defaultPath);
  if (!existsSync(profilePath)) {
    throw new Error(`GitHub App profile not found: ${profilePath}`);
  }

  const parsed = dotenv.parse(readFileSync(profilePath));
  const profile = appProfileSchema.parse(parsed);
  const keyPath = expandHome(profile.APP_PRIVATE_KEY_FILE);
  if (!existsSync(keyPath)) {
    throw new Error(`GitHub App private key file not found: ${keyPath}`);
  }

  return {
    ...profile,
    APP_PRIVATE_KEY_FILE: keyPath,
    privateKey: readFileSync(keyPath, 'utf8'),
    profilePath,
  };
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}
