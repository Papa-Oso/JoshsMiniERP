// @ts-nocheck
import fs from 'node:fs/promises';
import { listData } from '../inventoryService';
import { loadReviewProductAliases, replaceReviewProductAliases } from './feedbackStore';
let cachedCatalog;
let cachedCatalogStatus = {
  available: false,
  missing: false,
  count: 0,
  path: 'data/inventory.sqlite'
};

export async function enrichRowsWithProducts(rows) {
  const catalog = await loadProductCatalog();
  return rows.map((row) => {
    const title = row.matched_item_title || row.source_item_title || '';
    const sku = row.product_sku || findSkuForTitle(catalog, title);

    return {
      ...row,
      product_sku: sku,
      product_handle: sku ? slugForHandle(sku) : ''
    };
  });
}

export async function loadProductCatalog() {
  if (cachedCatalog) return cachedCatalog;

  const [data, aliases] = await Promise.all([listData(), loadReviewProductAliases()]);
  cachedCatalog = [...data.items.map((item) => ({ title: item.name, sku: item.sku })), ...aliases]
    .map((record) => ({ title: cleanTitle(record.title), normalizedTitle: normalizeTitle(record.title), sku: cleanText(record.sku) }))
    .filter((record) => record.title && record.sku);
  cachedCatalogStatus = { available: cachedCatalog.length > 0, missing: cachedCatalog.length === 0, count: cachedCatalog.length, path: 'data/inventory.sqlite' };

  return cachedCatalog;
}

export async function importProductCatalogCsv(file) {
  const rows = parseCsv(await fs.readFile(file, 'utf8'));
  const header = (rows[0] || []).map((value) => String(value).replace(/^\uFEFF/, '').trim());
  const titleIndex = header.indexOf('Title'); const skuIndex = header.indexOf('Custom label (SKU)');
  if (titleIndex < 0 || skuIndex < 0) throw new Error('Review product alias CSV must include Title and Custom label (SKU).');
  const aliases = rows.slice(1).map((row) => ({ title: cleanText(row[titleIndex]), sku: cleanText(row[skuIndex]) })).filter((row) => row.title && row.sku);
  const result = await replaceReviewProductAliases(aliases); cachedCatalog = undefined; return result;
}

export async function productCatalogStatus() {
  await loadProductCatalog();
  return cachedCatalogStatus;
}

export function findSkuForTitle(catalog, title = '') {
  const normalized = normalizeTitle(title);
  if (!normalized) return '';

  // Keep deterministic matches ahead of fuzzy scoring so obvious catalog hits
  // never lose to a nearby but incorrect title.
  const exact = catalog.find((record) => record.normalizedTitle === normalized);
  if (exact) return exact.sku;

  const contains = catalog.find((record) => {
    return normalized.includes(record.normalizedTitle) || record.normalizedTitle.includes(normalized);
  });
  if (contains) return contains.sku;

  const fuzzy = bestFuzzyTitleMatch(catalog, normalized);
  return fuzzy?.sku || '';
}

function bestFuzzyTitleMatch(catalog, normalizedTitle) {
  let bestMatch = null;

  for (const record of catalog) {
    const score = titleSimilarity(normalizedTitle, record.normalizedTitle);
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { ...record, score };
    }
  }

  return bestMatch?.score >= 0.72 ? bestMatch : null;
}

function titleSimilarity(left, right) {
  // Token overlap catches wording changes; character bigrams soften typos such
  // as "freecom" vs "freedom" without needing a third-party fuzzy library.
  const tokenScore = diceCoefficient(tokensFor(left), tokensFor(right));
  const bigramScore = diceCoefficient(bigramsFor(left), bigramsFor(right));
  return tokenScore * 0.55 + bigramScore * 0.45;
}

function diceCoefficient(left, right) {
  if (!left.length || !right.length) return 0;

  const counts = new Map();
  for (const value of left) counts.set(value, (counts.get(value) || 0) + 1);

  let overlap = 0;
  for (const value of right) {
    const count = counts.get(value) || 0;
    if (!count) continue;
    counts.set(value, count - 1);
    overlap += 1;
  }

  return (2 * overlap) / (left.length + right.length);
}

function tokensFor(value = '') {
  return value.split(' ').filter(Boolean);
}

function bigramsFor(value = '') {
  const compact = value.replace(/\s+/g, ' ');
  if (compact.length < 2) return compact ? [compact] : [];

  const bigrams = [];
  for (let index = 0; index < compact.length - 1; index += 1) {
    bigrams.push(compact.slice(index, index + 2));
  }
  return bigrams;
}

export function parseCsv(csv) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (char !== '\r') {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

export function slugForHandle(value = '') {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cleanTitle(value = '') {
  return cleanText(value).replace(/\s+\(#\d+\)\s*$/i, '');
}

function normalizeTitle(value = '') {
  return cleanTitle(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}
