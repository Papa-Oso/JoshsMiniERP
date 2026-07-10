// @ts-nocheck
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { config } from '../config';
import { sqliteDatabase } from '../sqliteDatabase';
import { normalizeFeedbackRow } from './normalization';

const database = sqliteDatabase(config.databaseFile);
const legacyFeedbackFile = path.resolve(process.env.FEEDBACK_DATA_FILE || 'data/feedback.sqlite');
let migrationChecked;

export async function applyFeedbackHistory(rows, { scanMode = 'full', platform = 'ebay' } = {}) {
  await ensureLegacyFeedbackMigrated();
  return database.write((db) => {
    createSchema(db);
    const now = new Date().toISOString();
    const mode = scanMode === 'incremental' ? 'incremental' : 'full';
    const outputRows = [];
    let newRows = 0;
    let skippedRows = 0;
    for (const importedRow of rows.map((row) => withStarRating({ platform, ...row }))) {
      const row = normalizeFeedbackRow(importedRow);
      const feedbackKey = feedbackKeyFor(row);
      const legacyFeedbackKey = feedbackKeyForRaw(importedRow);
      const existingKey = hasFeedback(db, feedbackKey) ? feedbackKey : legacyFeedbackKey !== feedbackKey && hasFeedback(db, legacyFeedbackKey) ? legacyFeedbackKey : '';
      const storageKey = existingKey || feedbackKey;
      const exists = Boolean(existingKey);
      const rowWithKey = { ...row, feedback_key: storageKey };
      upsertFeedback(db, storageKey, rowWithKey, now);
      if (exists && mode === 'incremental') { skippedRows += 1; continue; }
      if (!exists) newRows += 1;
      outputRows.push(rowWithKey);
    }
    const stats = { platform, scan_mode: mode, rows_seen: rows.length, rows_exported: outputRows.length, new_rows: newRows, skipped_existing_rows: skippedRows, database_path: config.databaseFile };
    insertFeedbackScanRun(db, stats, now);
    return { rows: outputRows, stats };
  });
}

export async function loadFeedbackHistory() {
  await ensureLegacyFeedbackMigrated();
  return database.read((db) => {
    createSchema(db);
    return queryRows(db, `SELECT platform, feedback_key, feedback_id, seller_username, source_item_id, source_item_title, source_item_image_url, matched_item_id, matched_item_title, matched_item_image_url, rating, star_rating, buyer_username, feedback_date, feedback_text, feedback_image_urls, source_listing_url, matched_item_url, feedback_profile_url, match_type, feedback_acknowledged_at, first_seen_at, last_seen_at FROM scanned_feedback ORDER BY last_seen_at DESC, first_seen_at DESC`).map(normalizeFeedbackRow);
  });
}

export async function acknowledgeFeedback(feedbackKey) {
  const key = String(feedbackKey || '').trim();
  if (!key) throw new Error('A feedback key is required.');
  await ensureLegacyFeedbackMigrated();
  return database.write((db) => {
    createSchema(db);
    const acknowledgedAt = new Date().toISOString();
    db.run(`UPDATE scanned_feedback SET feedback_acknowledged_at = ? WHERE feedback_key = ? AND lower(rating) = 'negative'`, [acknowledgedAt, key]);
    if (!db.getRowsModified()) throw new Error('Negative feedback was not found.');
    return { feedback_key: key, acknowledged_at: acknowledgedAt };
  });
}

export async function loadUnexportedFeedbackHistory() {
  await ensureLegacyFeedbackMigrated();
  return database.read((db) => {
    createSchema(db);
    return queryRows(db, `SELECT platform, feedback_key, feedback_id, seller_username, source_item_id, source_item_title, source_item_image_url, matched_item_id, matched_item_title, matched_item_image_url, rating, star_rating, buyer_username, feedback_date, feedback_text, feedback_image_urls, source_listing_url, matched_item_url, feedback_profile_url, match_type, first_seen_at, last_seen_at FROM scanned_feedback WHERE last_exported_at IS NULL ORDER BY first_seen_at ASC`).map(normalizeFeedbackRow);
  });
}

export async function markFeedbackExported(feedbackKeys) {
  const keys = [...new Set(feedbackKeys.map((key) => String(key || '').trim()).filter(Boolean))];
  if (!keys.length) return { exported_rows: 0, database_path: config.databaseFile };
  await ensureLegacyFeedbackMigrated();
  return database.write((db) => {
    createSchema(db);
    const now = new Date().toISOString();
    let exportedRows = 0;
    for (const key of keys) {
      db.run('UPDATE scanned_feedback SET last_exported_at = ? WHERE feedback_key = ?', [now, key]);
      exportedRows += db.getRowsModified();
    }
    return { exported_rows: exportedRows, database_path: config.databaseFile };
  });
}

export async function resetFeedbackExportHistory() {
  await ensureLegacyFeedbackMigrated();
  return database.write((db) => {
    createSchema(db);
    const resetRows = Number(queryRows(db, 'SELECT COUNT(*) AS count FROM scanned_feedback WHERE last_exported_at IS NOT NULL')[0]?.count ?? 0);
    db.run('UPDATE scanned_feedback SET last_exported_at = NULL');
    return { reset_rows: resetRows, database_path: config.databaseFile };
  });
}

export async function replaceReviewProductAliases(rows) {
  await ensureLegacyFeedbackMigrated();
  return database.write((db) => { createSchema(db); db.run('BEGIN'); try { db.run('DELETE FROM review_product_aliases'); for (const row of rows) db.run('INSERT INTO review_product_aliases (title, sku) VALUES (?, ?)', [String(row.title || '').trim(), String(row.sku || '').trim()]); db.run('COMMIT'); return { imported_rows: rows.length, database_path: config.databaseFile }; } catch (error) { db.run('ROLLBACK'); throw error; } });
}

export async function loadReviewProductAliases() {
  await ensureLegacyFeedbackMigrated();
  return database.read((db) => { createSchema(db); return queryRows(db, 'SELECT title, sku FROM review_product_aliases ORDER BY title'); });
}

export async function resetFeedbackHistory(platform = '') {
  await ensureLegacyFeedbackMigrated();
  return database.write((db) => {
    createSchema(db);
    const normalizedPlatform = String(platform || '').trim().toLowerCase();
    const deletedRows = normalizedPlatform ? platformRowCount(db, normalizedPlatform) : rowCount(db);
    if (normalizedPlatform) {
      db.run('DELETE FROM scanned_feedback WHERE platform = ?', [normalizedPlatform]);
      db.run('DELETE FROM feedback_scan_runs WHERE platform = ?', [normalizedPlatform]);
    } else {
      db.run('DELETE FROM scanned_feedback'); db.run('DELETE FROM feedback_scan_runs');
    }
    return { deleted_rows: deletedRows, database_path: config.databaseFile };
  });
}

export async function anonymizeFeedbackUsernames(usernames, { replacementFactory = randomDeletedUsername } = {}) {
  const candidates = uniqueNormalizedUsernames(usernames);
  if (!candidates.length) return { checkedUsernames: 0, matchedRows: 0, changedRows: 0, replacements: [] };
  await ensureLegacyFeedbackMigrated();
  return database.write((db) => {
    createSchema(db);
    const now = new Date().toISOString(); let matchedRows = 0; let changedRows = 0; const replacements = [];
    db.run('BEGIN TRANSACTION');
    try {
      for (const username of candidates) {
        const rows = matchingFeedbackRows(db, username); if (!rows.length) continue;
        const replacement = uniqueDeletedUsername(db, replacementFactory); replacements.push({ rows: rows.length, replacement }); matchedRows += rows.length;
        for (const row of rows) {
          const buyerUsername = normalizedUsername(row.buyer_username) === username ? replacement : row.buyer_username || '';
          const sellerUsername = normalizedUsername(row.seller_username) === username ? replacement : row.seller_username || '';
          db.run(`UPDATE scanned_feedback SET feedback_key = ?, buyer_username = ?, seller_username = ?, last_seen_at = ? WHERE feedback_key = ?`, [anonymizedFeedbackKey(row.feedback_key), buyerUsername, sellerUsername, now, row.feedback_key]);
          changedRows += db.getRowsModified();
        }
      }
      db.run('COMMIT');
      return { checkedUsernames: candidates.length, matchedRows, changedRows, replacements };
    } catch (error) { db.run('ROLLBACK'); throw error; }
  });
}

export async function loadFeedbackScanRuns(limit = 50) {
  await ensureLegacyFeedbackMigrated();
  return database.read((db) => {
    createSchema(db);
    const statement = db.prepare(`SELECT id, platform, scan_mode, rows_seen, rows_exported, new_rows, skipped_existing_rows, created_at FROM feedback_scan_runs ORDER BY created_at DESC, id DESC LIMIT ?`);
    try { statement.bind([Math.max(1, Math.floor(Number(limit) || 50))]); const rows=[]; while(statement.step()) rows.push(statement.getAsObject()); return rows; }
    finally { statement.free(); }
  });
}

export function withStarRating(row) { return { ...row, star_rating: row.star_rating === '' || row.star_rating == null ? starRatingFor(row.rating) : row.star_rating }; }
export function starRatingFor(rating = '') { const value=String(rating).toLowerCase(); return value==='positive'?5:value==='neutral'?2:value==='negative'?1:''; }
export function feedbackKeyFor(row) { return feedbackKeyForRaw(normalizeFeedbackRow(row)); }

async function ensureLegacyFeedbackMigrated() { migrationChecked ??= migrateLegacyFeedback(); return migrationChecked; }
async function migrateLegacyFeedback() {
  if (path.resolve(config.databaseFile) === legacyFeedbackFile) return;
  let raw; try { raw = await fs.readFile(legacyFeedbackFile); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  const SQL = await initSqlJs({ locateFile: (file) => path.resolve('node_modules','sql.js','dist',file) });
  const legacy = new SQL.Database(raw);
  try {
    createSchema(legacy);
    const feedback = queryRows(legacy, 'SELECT * FROM scanned_feedback');
    const runs = queryRows(legacy, 'SELECT * FROM feedback_scan_runs');
    if (!feedback.length && !runs.length) return;
    await database.write((db) => {
      createSchema(db);
      for (const row of feedback) insertRawFeedback(db, row);
      for (const row of runs) db.run(`INSERT OR IGNORE INTO feedback_scan_runs (id, platform, scan_mode, rows_seen, rows_exported, new_rows, skipped_existing_rows, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [row.id,row.platform,row.scan_mode,row.rows_seen,row.rows_exported,row.new_rows,row.skipped_existing_rows,row.created_at]);
    });
    const migrated = await database.read((db) => { createSchema(db); return Number(queryRows(db,'SELECT COUNT(*) AS count FROM scanned_feedback')[0]?.count ?? 0); });
    if (migrated < feedback.length) throw new Error(`Feedback migration verification failed: expected at least ${feedback.length} rows, found ${migrated}.`);
    await fs.rename(legacyFeedbackFile, `${legacyFeedbackFile}.migrated-${new Date().toISOString().replace(/[-:.]/g,'')}`);
  } finally { legacy.close(); }
}

function feedbackKeyForRaw(row) {
  const platform = String(row.platform || 'ebay').toLowerCase();
  if (row.feedback_id) return crypto.createHash('sha256').update(`${platform}|${row.feedback_id}`).digest('hex');
  const parts=[platform==='ebay'?'':platform,row.seller_username,row.source_item_id,row.matched_item_id,row.buyer_username,row.feedback_date,row.feedback_text].filter(Boolean);
  return crypto.createHash('sha256').update(parts.length?parts.join('|'):JSON.stringify(row)).digest('hex');
}
function createSchema(db) { db.run(schema); ensureColumn(db,'scanned_feedback','platform',"TEXT NOT NULL DEFAULT 'ebay'"); ensureColumn(db,'scanned_feedback','source_item_image_url','TEXT'); ensureColumn(db,'scanned_feedback','matched_item_image_url','TEXT'); ensureColumn(db,'scanned_feedback','feedback_image_urls','TEXT'); ensureColumn(db,'scanned_feedback','last_exported_at','TEXT'); ensureColumn(db,'scanned_feedback','feedback_acknowledged_at','TEXT'); ensureColumn(db,'feedback_scan_runs','platform',"TEXT NOT NULL DEFAULT 'ebay'"); }
function queryRows(db,sql){ const result=db.exec(sql)[0]; return result?result.values.map(values=>Object.fromEntries(result.columns.map((column,index)=>[column,values[index]??'']))):[]; }
function hasFeedback(db,key){ const statement=db.prepare('SELECT 1 FROM scanned_feedback WHERE feedback_key=? LIMIT 1'); try{statement.bind([key]);return statement.step();}finally{statement.free();} }
function rowCount(db){return Number(queryRows(db,'SELECT COUNT(*) AS count FROM scanned_feedback')[0]?.count??0);}
function platformRowCount(db,platform){const statement=db.prepare('SELECT COUNT(*) AS count FROM scanned_feedback WHERE platform=?');try{statement.bind([platform]);return statement.step()?Number(statement.getAsObject().count??0):0;}finally{statement.free();}}
function matchingFeedbackRows(db,username){const statement=db.prepare('SELECT feedback_key,buyer_username,seller_username FROM scanned_feedback WHERE lower(buyer_username)=lower(?) OR lower(seller_username)=lower(?)');try{statement.bind([username,username]);const rows=[];while(statement.step())rows.push(statement.getAsObject());return rows;}finally{statement.free();}}
function usernameExists(db,username){const statement=db.prepare('SELECT 1 FROM scanned_feedback WHERE lower(buyer_username)=lower(?) OR lower(seller_username)=lower(?) LIMIT 1');try{statement.bind([username,username]);return statement.step();}finally{statement.free();}}
function upsertFeedback(db,key,row,now){db.run(`INSERT INTO scanned_feedback (feedback_key,platform,feedback_id,seller_username,source_item_id,source_item_title,source_item_image_url,matched_item_id,matched_item_title,matched_item_image_url,rating,star_rating,buyer_username,feedback_date,feedback_text,feedback_image_urls,source_listing_url,matched_item_url,feedback_profile_url,match_type,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(feedback_key) DO UPDATE SET platform=excluded.platform,rating=excluded.rating,star_rating=excluded.star_rating,buyer_username=excluded.buyer_username,feedback_date=excluded.feedback_date,feedback_text=excluded.feedback_text,feedback_image_urls=excluded.feedback_image_urls,source_item_image_url=excluded.source_item_image_url,matched_item_title=excluded.matched_item_title,matched_item_url=excluded.matched_item_url,matched_item_image_url=excluded.matched_item_image_url,match_type=excluded.match_type,last_seen_at=excluded.last_seen_at`,feedbackValues(key,row,now));}
function feedbackValues(key,row,now){return [key,row.platform||'ebay',row.feedback_id||'',row.seller_username||'',row.source_item_id||'',row.source_item_title||'',row.source_item_image_url||'',row.matched_item_id||'',row.matched_item_title||'',row.matched_item_image_url||'',row.rating||'',row.star_rating===''?null:row.star_rating,row.buyer_username||'',row.feedback_date||'',row.feedback_text||'',row.feedback_image_urls||'',row.source_listing_url||'',row.matched_item_url||'',row.feedback_profile_url||'',row.match_type||'',now,now];}
function insertRawFeedback(db,row){db.run(`INSERT OR IGNORE INTO scanned_feedback (feedback_key,platform,feedback_id,seller_username,source_item_id,source_item_title,source_item_image_url,matched_item_id,matched_item_title,matched_item_image_url,rating,star_rating,buyer_username,feedback_date,feedback_text,feedback_image_urls,source_listing_url,matched_item_url,feedback_profile_url,match_type,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[row.feedback_key,row.platform,row.feedback_id,row.seller_username,row.source_item_id,row.source_item_title,row.source_item_image_url,row.matched_item_id,row.matched_item_title,row.matched_item_image_url,row.rating,row.star_rating,row.buyer_username,row.feedback_date,row.feedback_text,row.feedback_image_urls,row.source_listing_url,row.matched_item_url,row.feedback_profile_url,row.match_type,row.first_seen_at,row.last_seen_at]);}
function insertFeedbackScanRun(db,stats,now){db.run(`INSERT INTO feedback_scan_runs (id,platform,scan_mode,rows_seen,rows_exported,new_rows,skipped_existing_rows,created_at) VALUES (?,?,?,?,?,?,?,?)`,[crypto.randomUUID(),stats.platform||'ebay',stats.scan_mode,stats.rows_seen,stats.rows_exported,stats.new_rows,stats.skipped_existing_rows,now]);}
function ensureColumn(db,table,column,definition){const columns=db.exec(`PRAGMA table_info(${table})`)[0]?.values??[];if(!columns.some(row=>row[1]===column))db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);}
function normalizedUsername(value){return String(value||'').trim().toLowerCase();}
function uniqueNormalizedUsernames(values){return [...new Set((Array.isArray(values)?values:[values]).map(normalizedUsername).filter(Boolean))];}
function randomDeletedUsername(){return `deleted-${crypto.randomBytes(8).toString('hex')}`;}
function uniqueDeletedUsername(db,factory){for(let i=0;i<100;i+=1){const value=String(factory()).trim();if(value&&!usernameExists(db,value))return value;}throw new Error('Could not create a unique deleted username.');}
function anonymizedFeedbackKey(key){return crypto.createHash('sha256').update(`anonymized|${key}|${crypto.randomUUID()}`).digest('hex');}

const schema=`CREATE TABLE IF NOT EXISTS scanned_feedback (feedback_key TEXT PRIMARY KEY,platform TEXT NOT NULL DEFAULT 'ebay',feedback_id TEXT,seller_username TEXT,source_item_id TEXT,source_item_title TEXT,source_item_image_url TEXT,matched_item_id TEXT,matched_item_title TEXT,matched_item_image_url TEXT,rating TEXT,star_rating REAL,buyer_username TEXT,feedback_date TEXT,feedback_text TEXT,feedback_image_urls TEXT,source_listing_url TEXT,matched_item_url TEXT,feedback_profile_url TEXT,match_type TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_scanned_feedback_seller ON scanned_feedback(seller_username); CREATE INDEX IF NOT EXISTS idx_scanned_feedback_item ON scanned_feedback(source_item_id,matched_item_id); CREATE TABLE IF NOT EXISTS feedback_scan_runs (id TEXT PRIMARY KEY,platform TEXT NOT NULL DEFAULT 'ebay',scan_mode TEXT NOT NULL CHECK(scan_mode IN ('full','incremental')),rows_seen INTEGER NOT NULL DEFAULT 0,rows_exported INTEGER NOT NULL DEFAULT 0,new_rows INTEGER NOT NULL DEFAULT 0,skipped_existing_rows INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_feedback_scan_runs_created ON feedback_scan_runs(created_at DESC); CREATE TABLE IF NOT EXISTS review_product_aliases (title TEXT PRIMARY KEY, sku TEXT NOT NULL);`;
