// @ts-nocheck
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { normalizeFeedbackRow } from './normalization';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(process.env.ERP_ROOT_DIR || process.cwd());
const dataDir = path.join(rootDir, 'data');
const dbPath = path.resolve(process.env.FEEDBACK_DATA_FILE || path.join(dataDir, 'feedback.sqlite'));
let SQL;

// Applies the local scan memory used by incremental mode. Full scans still
// upsert into SQLite, while incremental scans skip rows whose stable key exists.
export async function applyFeedbackHistory(rows, { scanMode = 'full' } = {}) {
  const db = await openDatabase();
  const now = new Date().toISOString();
  const mode = scanMode === 'incremental' ? 'incremental' : 'full';
  const outputRows = [];
  let newRows = 0;
  let skippedRows = 0;

  try {
    for (const scrapedRow of rows.map(withStarRating)) {
      const row = normalizeFeedbackRow(scrapedRow);
      const feedbackKey = feedbackKeyFor(row);
      const legacyFeedbackKey = feedbackKeyForRaw(scrapedRow);
      const existingKey = hasFeedback(db, feedbackKey)
        ? feedbackKey
        : legacyFeedbackKey !== feedbackKey && hasFeedback(db, legacyFeedbackKey)
          ? legacyFeedbackKey
          : '';
      const storageKey = existingKey || feedbackKey;
      const exists = Boolean(existingKey);
      const rowWithKey = { ...row, feedback_key: storageKey };

      if (exists && mode === 'incremental') {
        skippedRows += 1;
        upsertFeedback(db, storageKey, rowWithKey, now);
        continue;
      }

      upsertFeedback(db, storageKey, rowWithKey, now);
      if (!exists) newRows += 1;
      outputRows.push(rowWithKey);
    }

    const stats = {
      scan_mode: mode,
      rows_seen: rows.length,
      rows_exported: outputRows.length,
      new_rows: newRows,
      skipped_existing_rows: skippedRows,
      database_path: dbPath
    };
    insertFeedbackScanRun(db, stats, now);
    await saveDatabase(db);

    return {
      rows: outputRows,
      stats
    };
  } finally {
    db.close();
  }
}

export async function loadFeedbackHistory() {
  const db = await openDatabase();

  try {
    const result = db.exec(`
      SELECT
        feedback_key,
        feedback_id,
        seller_username,
        source_item_id,
        source_item_title,
        source_item_image_url,
        matched_item_id,
        matched_item_title,
        matched_item_image_url,
        rating,
        star_rating,
        buyer_username,
        feedback_date,
        feedback_text,
        feedback_image_urls,
        source_listing_url,
        matched_item_url,
        feedback_profile_url,
        match_type,
        first_seen_at,
        last_seen_at
      FROM scanned_feedback
      ORDER BY last_seen_at DESC, first_seen_at DESC
    `);

    const columns = result[0]?.columns ?? [];
    return (result[0]?.values ?? []).map((values) => {
      return normalizeFeedbackRow(Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ''])));
    });
  } finally {
    db.close();
  }
}

export async function resetFeedbackHistory() {
  const db = await openDatabase();

  try {
    const deletedRows = rowCount(db);
    db.run('DELETE FROM scanned_feedback');
    db.run('DELETE FROM feedback_scan_runs');
    await saveDatabase(db);

    return {
      deleted_rows: deletedRows,
      database_path: dbPath
    };
  } finally {
    db.close();
  }
}

export async function anonymizeFeedbackUsernames(usernames, { replacementFactory = randomDeletedUsername } = {}) {
  const candidates = uniqueNormalizedUsernames(usernames);
  if (!candidates.length) {
    return {
      checkedUsernames: 0,
      matchedRows: 0,
      changedRows: 0,
      replacements: []
    };
  }

  const db = await openDatabase();
  const now = new Date().toISOString();
  let matchedRows = 0;
  let changedRows = 0;
  const replacements = [];

  try {
    db.run('BEGIN TRANSACTION');

    for (const username of candidates) {
      const rows = matchingFeedbackRows(db, username);
      if (!rows.length) continue;

      const replacement = uniqueDeletedUsername(db, replacementFactory);
      replacements.push({ rows: rows.length, replacement });
      matchedRows += rows.length;

      for (const row of rows) {
        const buyerUsername = normalizedUsername(row.buyer_username) === username ? replacement : row.buyer_username || '';
        const sellerUsername = normalizedUsername(row.seller_username) === username ? replacement : row.seller_username || '';
        db.run(
          `
            UPDATE scanned_feedback
            SET feedback_key = ?,
                buyer_username = ?,
                seller_username = ?,
                last_seen_at = ?
            WHERE feedback_key = ?
          `,
          [anonymizedFeedbackKey(row.feedback_key), buyerUsername, sellerUsername, now, row.feedback_key]
        );
        changedRows += typeof db.getRowsModified === 'function' ? db.getRowsModified() : 1;
      }
    }

    db.run('COMMIT');
    if (changedRows > 0) await saveDatabase(db);

    return {
      checkedUsernames: candidates.length,
      matchedRows,
      changedRows,
      replacements
    };
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch {
      // Ignore rollback failures and report the original error.
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function loadFeedbackScanRuns(limit = 50) {
  const db = await openDatabase();

  try {
    const statement = db.prepare(`
      SELECT id, scan_mode, rows_seen, rows_exported, new_rows, skipped_existing_rows, created_at
      FROM feedback_scan_runs
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `);
    try {
      statement.bind([Math.max(1, Math.floor(Number(limit) || 50))]);
      const rows = [];
      while (statement.step()) {
        rows.push(statement.getAsObject());
      }
      return rows;
    } finally {
      statement.free();
    }
  } finally {
    db.close();
  }
}

export function withStarRating(row) {
  return {
    ...row,
    star_rating: starRatingFor(row.rating)
  };
}

export function starRatingFor(rating = '') {
  const normalized = String(rating).toLowerCase();
  if (normalized === 'positive') return 5;
  if (normalized === 'neutral') return 2;
  if (normalized === 'negative') return 1;
  return '';
}

export function feedbackKeyFor(row) {
  return feedbackKeyForRaw(normalizeFeedbackRow(row));
}

function feedbackKeyForRaw(row) {
  // Prefer eBay-provided and product-specific fields, then hash them so a row
  // can be recognized across future scans without storing a brittle raw string key.
  const stableParts = [
    row.feedback_id,
    row.seller_username,
    row.source_item_id,
    row.matched_item_id,
    row.buyer_username,
    row.feedback_date,
    row.feedback_text
  ].filter(Boolean);

  const rawKey = stableParts.length ? stableParts.join('|') : JSON.stringify(row);
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

async function openDatabase() {
  SQL ??= await initSqlJs({
    locateFile: (file) => path.join(rootDir, 'node_modules', 'sql.js', 'dist', file)
  });

  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  let db;
  try {
    const buffer = await fs.readFile(dbPath);
    db = new SQL.Database(buffer);
  } catch {
    db = new SQL.Database();
  }

  createSchema(db);
  return db;
}

function createSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS scanned_feedback (
      feedback_key TEXT PRIMARY KEY,
      feedback_id TEXT,
      seller_username TEXT,
      source_item_id TEXT,
      source_item_title TEXT,
      source_item_image_url TEXT,
      matched_item_id TEXT,
      matched_item_title TEXT,
      matched_item_image_url TEXT,
      rating TEXT,
      star_rating REAL,
      buyer_username TEXT,
      feedback_date TEXT,
      feedback_text TEXT,
      feedback_image_urls TEXT,
      source_listing_url TEXT,
      matched_item_url TEXT,
      feedback_profile_url TEXT,
      match_type TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scanned_feedback_seller
      ON scanned_feedback (seller_username);

    CREATE INDEX IF NOT EXISTS idx_scanned_feedback_item
      ON scanned_feedback (source_item_id, matched_item_id);

    CREATE TABLE IF NOT EXISTS feedback_scan_runs (
      id TEXT PRIMARY KEY,
      scan_mode TEXT NOT NULL CHECK (scan_mode IN ('full', 'incremental')),
      rows_seen INTEGER NOT NULL DEFAULT 0,
      rows_exported INTEGER NOT NULL DEFAULT 0,
      new_rows INTEGER NOT NULL DEFAULT 0,
      skipped_existing_rows INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_scan_runs_created
      ON feedback_scan_runs (created_at DESC);
  `);

  // sql.js stores a plain SQLite file, so lightweight ALTER migrations keep
  // existing local databases compatible after new scraper fields are added.
  ensureColumn(db, 'source_item_image_url', 'TEXT');
  ensureColumn(db, 'matched_item_image_url', 'TEXT');
  ensureColumn(db, 'feedback_image_urls', 'TEXT');
}

function rowCount(db) {
  const result = db.exec('SELECT COUNT(*) FROM scanned_feedback');
  return result[0]?.values?.[0]?.[0] ?? 0;
}

function ensureColumn(db, columnName, definition) {
  const columns = db.exec('PRAGMA table_info(scanned_feedback)')[0]?.values ?? [];
  const hasColumn = columns.some((column) => column[1] === columnName);
  if (!hasColumn) db.run(`ALTER TABLE scanned_feedback ADD COLUMN ${columnName} ${definition}`);
}

function hasFeedback(db, feedbackKey) {
  const statement = db.prepare('SELECT 1 FROM scanned_feedback WHERE feedback_key = ? LIMIT 1');
  try {
    statement.bind([feedbackKey]);
    return statement.step();
  } finally {
    statement.free();
  }
}

function matchingFeedbackRows(db, username) {
  const statement = db.prepare(`
    SELECT feedback_key, buyer_username, seller_username
    FROM scanned_feedback
    WHERE lower(buyer_username) = lower(?) OR lower(seller_username) = lower(?)
  `);
  try {
    statement.bind([username, username]);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function usernameExists(db, username) {
  const statement = db.prepare(`
    SELECT 1
    FROM scanned_feedback
    WHERE lower(buyer_username) = lower(?) OR lower(seller_username) = lower(?)
    LIMIT 1
  `);
  try {
    statement.bind([username, username]);
    return statement.step();
  } finally {
    statement.free();
  }
}

function touchFeedback(db, feedbackKey, now) {
  db.run('UPDATE scanned_feedback SET last_seen_at = ? WHERE feedback_key = ?', [now, feedbackKey]);
}

function upsertFeedback(db, feedbackKey, row, now) {
  db.run(
    `
      INSERT INTO scanned_feedback (
        feedback_key,
        feedback_id,
        seller_username,
        source_item_id,
        source_item_title,
        source_item_image_url,
        matched_item_id,
        matched_item_title,
        matched_item_image_url,
        rating,
        star_rating,
        buyer_username,
        feedback_date,
        feedback_text,
        feedback_image_urls,
        source_listing_url,
        matched_item_url,
        feedback_profile_url,
        match_type,
        first_seen_at,
        last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feedback_key) DO UPDATE SET
        rating = excluded.rating,
        star_rating = excluded.star_rating,
        buyer_username = excluded.buyer_username,
        feedback_date = excluded.feedback_date,
        feedback_text = excluded.feedback_text,
        feedback_image_urls = excluded.feedback_image_urls,
        source_item_image_url = excluded.source_item_image_url,
        matched_item_title = excluded.matched_item_title,
        matched_item_url = excluded.matched_item_url,
        matched_item_image_url = excluded.matched_item_image_url,
        match_type = excluded.match_type,
        last_seen_at = excluded.last_seen_at
    `,
    [
      feedbackKey,
      row.feedback_id || '',
      row.seller_username || '',
      row.source_item_id || '',
      row.source_item_title || '',
      row.source_item_image_url || '',
      row.matched_item_id || '',
      row.matched_item_title || '',
      row.matched_item_image_url || '',
      row.rating || '',
      row.star_rating === '' ? null : row.star_rating,
      row.buyer_username || '',
      row.feedback_date || '',
      row.feedback_text || '',
      row.feedback_image_urls || '',
      row.source_listing_url || '',
      row.matched_item_url || '',
      row.feedback_profile_url || '',
      row.match_type || '',
      now,
      now
    ]
  );
}

function insertFeedbackScanRun(db, stats, now) {
  db.run(
    `
      INSERT INTO feedback_scan_runs (
        id, scan_mode, rows_seen, rows_exported, new_rows, skipped_existing_rows, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      crypto.randomUUID(),
      stats.scan_mode,
      stats.rows_seen,
      stats.rows_exported,
      stats.new_rows,
      stats.skipped_existing_rows,
      now
    ]
  );
}

function uniqueNormalizedUsernames(usernames) {
  return [...new Set((Array.isArray(usernames) ? usernames : [usernames]).map(normalizedUsername).filter(Boolean))];
}

function normalizedUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function uniqueDeletedUsername(db, replacementFactory) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const replacement = replacementFactory();
    if (!usernameExists(db, replacement)) return replacement;
  }
  return `deleted-user-${crypto.randomUUID()}`;
}

function randomDeletedUsername() {
  const adjectives = ['quiet', 'silver', 'cedar', 'amber', 'north', 'hidden', 'clear', 'bright'];
  const nouns = ['river', 'stone', 'harbor', 'meadow', 'signal', 'canvas', 'orbit', 'field'];
  const adjective = adjectives[crypto.randomInt(adjectives.length)];
  const noun = nouns[crypto.randomInt(nouns.length)];
  return `deleted-${adjective}-${noun}-${crypto.randomBytes(3).toString('hex')}`;
}

function anonymizedFeedbackKey(feedbackKey) {
  return crypto.createHash('sha256').update(`${feedbackKey}|${crypto.randomUUID()}`).digest('hex');
}

async function saveDatabase(db) {
  const data = db.export();
  await fs.writeFile(dbPath, Buffer.from(data));
}
