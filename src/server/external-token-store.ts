import type mysql from 'mysql2/promise';

import { getMysqlPool } from './db';

export interface ExternalApiTokenRecord {
  provider: string;
  game_key: string;
  subject_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

let migrated = false;

async function ensureExternalTokenTable(): Promise<void> {
  if (migrated) return;
  const pool = await getMysqlPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS external_api_tokens (
      provider VARCHAR(64) NOT NULL,
      game_key VARCHAR(32) NOT NULL,
      subject_id VARCHAR(128) NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at BIGINT NOT NULL DEFAULT 0,
      metadata_json JSON NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (provider, game_key, subject_id),
      INDEX idx_provider_expiry (provider, expires_at)
    )
  `);
  migrated = true;
}

export async function getExternalApiToken(input: {
  provider: string;
  gameKey: string;
  subjectId: string;
}): Promise<ExternalApiTokenRecord | null> {
  await ensureExternalTokenTable();
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT * FROM external_api_tokens
      WHERE provider = ? AND game_key = ? AND subject_id = ?
      LIMIT 1`,
    [input.provider, input.gameKey, input.subjectId],
  );
  return ((rows as ExternalApiTokenRecord[])[0] || null);
}

export async function upsertExternalApiToken(input: {
  provider: string;
  gameKey: string;
  subjectId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  metadata?: unknown;
}): Promise<void> {
  await ensureExternalTokenTable();
  const pool = await getMysqlPool();
  const now = Date.now();
  await pool.query(
    `INSERT INTO external_api_tokens (
       provider, game_key, subject_id, access_token, refresh_token,
       expires_at, metadata_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       access_token = VALUES(access_token),
       refresh_token = VALUES(refresh_token),
       expires_at = VALUES(expires_at),
       metadata_json = VALUES(metadata_json),
       updated_at = VALUES(updated_at)`,
    [
      input.provider,
      input.gameKey,
      input.subjectId,
      input.accessToken,
      input.refreshToken || '',
      input.expiresAt,
      JSON.stringify(input.metadata || {}),
      now,
      now,
    ],
  );
}

export function isDuplicateKeyError(error: unknown): boolean {
  return (error as mysql.QueryError | undefined)?.code === 'ER_DUP_ENTRY';
}
