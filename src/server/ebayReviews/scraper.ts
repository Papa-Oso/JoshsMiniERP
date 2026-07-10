// @ts-nocheck
import { chromium } from 'playwright';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { normalizeFeedbackDate } from './normalization';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const rootDir = path.resolve(process.env.ERP_ROOT_DIR || process.cwd());
const browserProfileDir = path.join(rootDir, 'data', 'browser-profile');

export async function scrapeEbayFeedback({
  inputUrl,
  mode = 'auto',
  maxItems = 25,
  maxPages = 8,
  allowManualVerification = true,
  useSavedSession = true
}) {
  const { browser, context, page } = await createBrowserSession({ allowManualVerification, useSavedSession });
  const warnings = [];

  try {
    if (useSavedSession) {
      await ensureSavedSessionLogin(page, warnings);
    }

    const normalizedUrl = normalizeUrl(inputUrl);
    const urlMode = inferMode(normalizedUrl);
    const inferredMode = urlMode === 'seller' ? 'seller' : mode === 'auto' ? urlMode : mode;
    const scrapeOptions = { allowManualVerification, useSavedSession, warnings };
    const listings =
      inferredMode === 'seller'
        ? [await readSellerProfileDetails(page, normalizedUrl, scrapeOptions)]
        : inferredMode === 'store'
          ? await collectStoreListings(page, normalizedUrl, maxItems, scrapeOptions)
          : [await readListingDetails(page, normalizedUrl, scrapeOptions)];

    const rows = [];
    for (const listing of listings) {
      if (listing.embeddedFeedbackRows?.length) {
        rows.push(...listing.embeddedFeedbackRows);
        if (inferredMode === 'listing' || inferredMode === 'store') continue;
      }

      if (inferredMode === 'store') {
        warnings.push(`No item-specific feedback was visible for ${listing.url}.`);
        continue;
      }

      if (!listing.sellerUsername) {
        warnings.push(`Skipped ${listing.url}: seller username was not visible.`);
        continue;
      }

      const feedbackRows = await scrapeSellerFeedback(page, listing, maxPages, scrapeOptions);
      rows.push(...feedbackRows);
    }

    return {
      scannedAt: new Date().toISOString(),
      inputUrl: normalizedUrl,
      mode: inferredMode,
      listings,
      rows: dedupeRows(rows),
      warnings
    };
  } catch (error) {
    throw normalizeScrapeError(error);
  } finally {
    await context.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

async function createBrowserSession({ allowManualVerification, useSavedSession }) {
  const launchMode = browserLaunchMode({ allowManualVerification, useSavedSession });
  const contextOptions = {
    userAgent: USER_AGENT,
    locale: 'en-US',
    viewport: { width: 1365, height: 900 }
  };

  if (launchMode === 'persistent-headed') {
    const context = await chromium.launchPersistentContext(browserProfileDir, {
      ...contextOptions,
      headless: false
    });
    const page = context.pages()[0] || (await context.newPage());
    return { browser: null, context, page };
  }

  const browser = await chromium.launch({ headless: launchMode === 'headless' });
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  return { browser, context, page };
}

function browserLaunchMode({ allowManualVerification, useSavedSession }) {
  if (useSavedSession) return 'persistent-headed';
  return allowManualVerification ? 'headed' : 'headless';
}

async function ensureSavedSessionLogin(page, warnings) {
  // The startup path should be fast when cookies are still valid. A DOM/text
  // check is enough to distinguish signed-in vs signed-out eBay chrome.
  await navigateWithRetry(page, 'https://www.ebay.com/');
  const html = await readFastContent(page);

  if (!isLoggedOutEbayPage(html, page.url())) return;

  warnings.push('Saved eBay session was not logged in, so Chromium opened the eBay sign-in page.');
  await navigateWithRetry(page, 'https://signin.ebay.com/ws/eBayISAPI.dll?SignIn');

  try {
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText || '';
        const url = location.href;
        const loggedOut =
          /signin\.ebay\./i.test(url) ||
          /\bHi!\s*Sign in\b/i.test(text) ||
          /\bSign in or register\b/i.test(text) ||
          /\bEmail or username\b/i.test(text);
        return !loggedOut;
      },
      undefined,
      { timeout: 10 * 60 * 1000 }
    );
    await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
  } catch {
    throw new Error('Timed out waiting for eBay login. Log in inside the Chromium window, then run the scrape again.');
  }
}

async function readFastContent(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(
    () => document.body && document.body.innerText.trim().length > 0,
    undefined,
    { timeout: 2500 }
  ).catch(() => {});

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.content();
    } catch (error) {
      if (!String(error.message || '').includes('page is navigating')) throw error;
      await page.waitForTimeout(250);
    }
  }

  return '';
}

function isLoggedOutEbayPage(html = '', url = '') {
  const $ = cheerio.load(html);
  const text = cleanText($('body').text());
  const hasSignOutLink = $('a[href*="SignOut"], a[href*="signout"]').length > 0 || /\bSign out\b/i.test(text);
  const hasSignInLink = $('a[href*="signin.ebay."], a[href*="eBayISAPI.dll?SignIn"]').length > 0;
  if (hasSignOutLink) return false;

  return (
    /signin\.ebay\./i.test(url) ||
    /\bHi!\s*Sign in\b/i.test(text) ||
    /\bSign in or register\b/i.test(text) ||
    /\bEmail or username\b/i.test(text) ||
    /\bContinue to sign in\b/i.test(text) ||
    (hasSignInLink && /\bregister\b|\bSign in\b/i.test(text))
  );
}

async function collectStoreListings(page, storeUrl, maxItems, options) {
  const listingUrls = new Set();
  let nextUrl = storeUrl;

  while (nextUrl && listingUrls.size < maxItems) {
    await goto(page, nextUrl, options);
    let html = await readStableContent(page);
    html = await handleEbayErrorPage(page, html, nextUrl, options);
    for (const url of extractListingUrls(html, nextUrl)) {
      listingUrls.add(url);
      if (listingUrls.size >= maxItems) break;
    }
    nextUrl = findNextPageUrl(html, nextUrl);
  }

  if (listingUrls.size === 0) {
    const sellerProfile = await readSellerProfileDetails(page, storeUrl, options);
    if (sellerProfile.sellerUsername) {
      options.warnings.push('No listing links were found, so seller feedback was exported directly.');
      return [sellerProfile];
    }
    options.warnings.push('No listing links were found on that store page.');
  }

  const listings = [];
  for (const url of [...listingUrls].slice(0, maxItems)) {
    listings.push(await readListingDetails(page, url, options));
  }
  return listings;
}

async function readSellerProfileDetails(page, profileUrl, options) {
  const usernameFromUrl = extractSellerUsernameFromUrl(profileUrl);
  if (usernameFromUrl) {
    return {
      url: profileUrl,
      itemId: '',
      title: 'Seller feedback profile',
      sellerUsername: usernameFromUrl,
      feedbackUrl: feedbackProfileUrl(usernameFromUrl)
    };
  }

  await goto(page, profileUrl, options);
  let html = await readStableContent(page);
  html = await handleEbayErrorPage(page, html, profileUrl, options);
  const $ = cheerio.load(html);
  const sellerUsername = extractSellerUsername($, html);

  if (!sellerUsername) {
    options.warnings.push(`Could not find seller username for ${profileUrl}.`);
  }

  return {
    url: profileUrl,
    itemId: '',
    title: 'Seller feedback profile',
    sellerUsername,
    feedbackUrl: sellerUsername ? feedbackProfileUrl(sellerUsername) : profileUrl
  };
}

async function readListingDetails(page, listingUrl, options) {
  await goto(page, listingUrl, options);
  let html = await readStableContent(page);
  html = await handleEbayErrorPage(page, html, listingUrl, options);
  const $ = cheerio.load(html);
  const itemId = extractItemId(listingUrl) || extractItemId(html);
  const title = cleanText(
    $('[data-testid="x-item-title"]').first().text() ||
      $('h1.x-item-title__mainTitle').first().text() ||
      $('h1').first().text() ||
      $('title').first().text().replace(/\| eBay.*/i, '')
  );
  const sellerUsername = extractSellerUsername($, html);

  if (!sellerUsername) {
    options.warnings.push(`Could not find seller username for ${listingUrl}.`);
  }

  const listing = {
    url: listingUrl,
    itemId,
    title,
    sellerUsername,
    feedbackUrl: sellerUsername ? feedbackProfileUrl(sellerUsername) : null
  };
  listing.embeddedFeedbackRows = parseListingPageFeedbackRows(html, listing);
  return listing;
}

async function scrapeSellerFeedback(page, listing, maxPages, options) {
  const rows = [];
  const seenPageKeys = new Set();

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const url = feedbackPageUrl(listing.feedbackUrl, pageNumber);
    await goto(page, url, options);
    let html = await readStableContent(page);
    html = await handleEbayErrorPage(page, html, url, options);
    const pageRows = parseFeedbackRows(html, listing);
    const pageKey = pageRows.map((row) => row.feedback_id || row.feedback_text).join('|');
    if (!pageRows.length || seenPageKeys.has(pageKey)) break;
    seenPageKeys.add(pageKey);
    rows.push(...pageRows);

    const exactRows = pageRows.filter((row) => row.match_type !== 'seller-profile');
    if (exactRows.length > 0 && exactRows.length === pageRows.length) break;

    const totalPages = extractFeedbackTotalPages(html);
    if (totalPages && pageNumber >= totalPages) break;
  }

  if (rows.length === 0) {
    options.warnings.push(`No feedback rows were readable for seller ${listing.sellerUsername}.`);
  }

  return rows;
}

function parseFeedbackRows(html, listing) {
  const $ = cheerio.load(html);
  const tableRows = parseFeedbackTableRows($, listing);
  if (tableRows.length > 0) return tableRows;

  const rowCandidates = [
    '.card__feedback',
    '.fdbk-detail-list__item',
    'li:has(time)',
    'tr:has(time)'
  ].join(',');

  const rows = [];
  $(rowCandidates).each((_index, element) => {
    const rowText = cleanText($(element).text());
    if (isPageChrome(rowText) || isFeedbackLeftForSeller(rowText)) return;
    if (!looksLikeFeedback(rowText)) return;

    const itemText = cleanText(
      $(element).find('a[href*="/itm/"]').first().text() ||
        $(element).find('[class*="item"]').first().text()
    );
    const itemUrl = absoluteUrl($(element).find('a[href*="/itm/"]').first().attr('href'));
    const itemId = extractItemId(itemUrl || rowText);
    const comment = cleanText(
      $(element).find('[class*="comment"], [class*="rating"], [data-test-id*="comment"]').first().text()
    ) || rowText;
    const date = normalizeFeedbackDate(
      $(element).find('time').first().attr('datetime') || $(element).find('time').first().text()
    );
    const buyer = normalizeFeedbackFrom($(element).find('a[href*="/usr/"]').last().text());
    const rating = inferRating(rowText);
    const matchType = inferMatchType({ listing, itemId, itemText, rowText });

    rows.push({
      source_listing_url: listing.url,
      source_item_id: listing.itemId || '',
      source_item_title: listing.title || '',
      source_item_image_url: '',
      seller_username: listing.sellerUsername || '',
      feedback_profile_url: listing.feedbackUrl || '',
      matched_item_id: itemId || '',
      matched_item_title: itemText || '',
      matched_item_url: itemUrl || '',
      matched_item_image_url: '',
      feedback_image_urls: extractFeedbackImageUrls($, $(element), itemUrl || listing.url),
      match_type: matchType,
      rating,
      buyer_username: buyer,
      feedback_date: date,
      feedback_text: comment
    });
  });

  return rows.length > 0 ? rows : parseFallbackFeedback(html, listing);
}

function parseListingPageFeedbackRows(html, listing) {
  const $ = cheerio.load(html);
  const rows = [];

  for (const row of parseFeedbackTableRows($, listing)) {
    if (row.match_type !== 'seller-profile') rows.push({ ...row, match_type: 'listing-page' });
  }

  const cardSelectors = [
    '.card__feedback',
    '[data-testid*="feedback"]',
    '[class*="review"]'
  ].join(',');

  $(cardSelectors).each((_index, element) => {
    const container = $(element).closest('li, article, tr, [class*="card"], [class*="feedback"]');
    const rowText = cleanText((container.length ? container : $(element)).text());
    const comment = cleanText(
      $(element).find('[aria-label]').first().attr('aria-label') ||
        $(element).find('[class*="comment"]').first().text() ||
        $(element).text()
    );
    const itemId = extractItemId(rowText) || listing.itemId || '';

    if (
      !comment ||
      isPageChrome(rowText) ||
      isPageChrome(comment) ||
      isNonReviewFeedbackText(comment) ||
      isNonReviewFeedbackText(rowText) ||
      isFeedbackLeftForSeller(rowText)
    ) return;
    if (!looksLikeFeedback(`${comment} ${rowText}`) && itemId !== listing.itemId) return;
    if (/Seller feedback|This item|All items|See all feedback/i.test(comment) && comment.length < 80) return;

    const matchType = listing.itemId && itemId === listing.itemId ? 'listing-page' : inferMatchType({ listing, itemId, rowText });
    if (matchType === 'seller-profile' && !rowText.includes(listing.itemId)) return;

    rows.push({
      feedback_id: extractFeedbackId(rowText) || `listing-${listing.itemId || 'item'}-${rows.length + 1}`,
      source_listing_url: listing.url,
      source_item_id: listing.itemId || '',
      source_item_title: listing.title || '',
      source_item_image_url: '',
      seller_username: listing.sellerUsername || '',
      feedback_profile_url: listing.feedbackUrl || '',
      matched_item_id: itemId,
      matched_item_title: listing.title || '',
      matched_item_url: listing.url,
      matched_item_image_url: '',
      feedback_image_urls: extractFeedbackImageUrls($, container.length ? container : $(element), listing.url),
      match_type: 'listing-page',
      rating: normalizeRating(rowText),
      buyer_username: normalizeFeedbackFrom(container.find('a[href*="/usr/"]').last().text()),
      feedback_date: normalizeFeedbackDate(extractRelativeDate(rowText)),
      feedback_text: comment
    });
  });

  return dedupeRows(rows).slice(0, 50);
}

function parseFeedbackTableRows($, listing) {
  const rows = [];

  $('tr[data-feedback-id]').each((_index, element) => {
    const row = $(element);
    const cells = row.find('td');
    const feedbackCell = cells.eq(0);
    const fromText = cleanText(cells.eq(1).text());
    const date = normalizeFeedbackDate(cells.eq(2).text());
    const rowText = cleanText(row.text());

    if (isPageChrome(rowText) || isFeedbackLeftForSeller(fromText)) return;

    const comment = cleanText(
      feedbackCell.find('.card__comment span').first().attr('aria-label') ||
        feedbackCell.find('.card__comment').first().text() ||
        feedbackCell.find('.card__feedback').first().text()
    );
    if (!comment || isPageChrome(comment) || isNonReviewFeedbackText(comment)) return;

    const itemText = cleanText(feedbackCell.find('.card__item').first().text());
    const itemLink = feedbackCell.find('a[href*="/itm/"]').first();
    const itemUrl = absoluteUrl(itemLink.attr('href'));
    const itemId = extractItemId(itemUrl || itemText || rowText);
    const rating = normalizeRating(
      feedbackCell.find('[data-test-type]').first().attr('data-test-type') ||
        feedbackCell.find('[aria-label*="feedback rating" i]').first().attr('aria-label') ||
        rowText
    );
    const matchType = inferMatchType({ listing, itemId, itemText, rowText });

    rows.push({
      feedback_id: row.attr('data-feedback-id') || '',
      source_listing_url: listing.url,
      source_item_id: listing.itemId || '',
      source_item_title: listing.title || '',
      source_item_image_url: '',
      seller_username: listing.sellerUsername || '',
      feedback_profile_url: listing.feedbackUrl || '',
      matched_item_id: itemId || '',
      matched_item_title: itemText || '',
      matched_item_url: itemUrl || '',
      matched_item_image_url: '',
      feedback_image_urls: extractFeedbackImageUrls($, row, itemUrl || listing.url),
      match_type: matchType,
      rating,
      buyer_username: normalizeFeedbackFrom(fromText),
      feedback_date: date,
      feedback_text: comment
    });
  });

  return rows;
}

function parseFallbackFeedback(html, listing) {
  const $ = cheerio.load(html);
  const textBlocks = $('li, tr, article, div')
    .toArray()
    .map((element) => cleanText($(element).text()))
    .filter((text) => (
      text.length > 35 &&
      !isPageChrome(text) &&
      !isNonReviewFeedbackText(text) &&
      !isFeedbackLeftForSeller(text) &&
      looksLikeFeedback(text)
    ))
    .slice(0, 80);

  return [...new Set(textBlocks)].map((text) => ({
    source_listing_url: listing.url,
    source_item_id: listing.itemId || '',
    source_item_title: listing.title || '',
    source_item_image_url: '',
    seller_username: listing.sellerUsername || '',
    feedback_profile_url: listing.feedbackUrl || '',
    matched_item_id: extractItemId(text) || '',
    matched_item_title: '',
    matched_item_url: '',
    matched_item_image_url: '',
    feedback_image_urls: '',
    match_type: inferMatchType({ listing, rowText: text }),
    rating: inferRating(text),
    buyer_username: '',
    feedback_date: normalizeFeedbackDate(extractDate(text)),
    feedback_text: text
  }));
}

function inferMatchType({ listing, itemId, itemText = '', rowText = '' }) {
  if (listing.itemId && itemId && listing.itemId === itemId) return 'item-id';
  const title = normalizeForMatch(listing.title);
  const haystack = normalizeForMatch(`${itemText} ${rowText}`);
  if (title && haystack.includes(title.slice(0, Math.min(45, title.length)))) return 'title';
  return 'seller-profile';
}

function extractSellerUsername($, html) {
  const profileHref = $('a[href*="/usr/"], a[href*="/str/"]').toArray()
    .map((element) => $(element).attr('href'))
    .find(Boolean);
  const fromHref = profileHref?.match(/\/(?:usr|str)\/([^/?#]+)/i)?.[1];
  if (fromHref) return decodeURIComponent(fromHref);

  const textMatch =
    html.match(/"sellerUsername"\s*:\s*"([^"]+)"/i) ||
    html.match(/"loginName"\s*:\s*"([^"]+)"/i) ||
    html.match(/\/fdbk\/feedback_profile\/([^/?#"]+)/i) ||
    html.match(/requested=([^&#"]+)/i) ||
    html.match(/"mbgLink"\s*:\s*"[^"]*\/usr\/([^/?#"]+)/i) ||
    html.match(/\/usr\/([^/?#"]+)/i);
  return textMatch ? decodeURIComponent(textMatch[1]) : '';
}

function extractFeedbackImageUrls($, scope, baseUrl = '') {
  const scoped = scope?.length ? scope : $('body');
  const urls = [];

  // Shopify should receive buyer-uploaded review photos only. eBay product
  // images use different URL shapes and are filtered out by isFeedbackImageUrl.
  scoped.find('img, source, a[href], [data-src], [data-original], [srcset]').each((_index, element) => {
    const node = $(element);
    const candidates = [
      node.attr('src'),
      node.attr('data-src'),
      node.attr('data-original'),
      node.attr('href'),
      ...srcsetUrls(node.attr('srcset'))
    ];

    for (const candidate of candidates) {
      const url = absoluteUrl(candidate, baseUrl);
      if (isFeedbackImageUrl(url)) urls.push(normalizeEbayImageUrl(url));
    }
  });

  return [...new Set(urls)].join(',');
}

function srcsetUrls(value = '') {
  return String(value)
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function isFeedbackImageUrl(url = '') {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return /(^|\.)ebayimg\.com$/i.test(parsed.hostname) && /\/\$_\d+\.(?:jpe?g|png|webp)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalizeEbayImageUrl(url = '') {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    // Some Shopify import validators reject raw "$" even though browsers load it.
    parsed.pathname = parsed.pathname.replaceAll('$', '%24');
    return parsed.toString();
  } catch {
    return String(url).replace(/[?#].*$/, '').replaceAll('$', '%24');
  }
}

function extractListingUrls(html, baseUrl) {
  const $ = cheerio.load(html);
  const urls = new Set();
  $('a[href*="/itm/"]').each((_index, element) => {
    const href = $(element).attr('href');
    const absolute = absoluteUrl(href, baseUrl);
    if (absolute && extractItemId(absolute)) urls.add(stripTracking(absolute));
  });
  return [...urls];
}

function findNextPageUrl(html, baseUrl) {
  const $ = cheerio.load(html);
  const href =
    $('a[rel="next"]').attr('href') ||
    $('a.pagination__next').attr('href') ||
    $('a[aria-label*="next" i]').attr('href') ||
    $('a:contains("Next")').attr('href');
  return absoluteUrl(href, baseUrl);
}

function extractFeedbackTotalPages(html = '') {
  const $ = cheerio.load(html);
  const text = cleanText($('body').text());
  const pageMatch = text.match(/\bPage\s+\d+\s+of\s+(\d+)\b/i);
  if (pageMatch) return Number(pageMatch[1]);

  const pageIds = $('[value*="page_id="], a[href*="page_id="]')
    .toArray()
    .map((element) => {
      const value = $(element).attr('value') || $(element).attr('href') || '';
      return Number(value.match(/[?&]page_id=(\d+)/i)?.[1]);
    })
    .filter(Number.isFinite);

  return pageIds.length ? Math.max(...pageIds) : 0;
}

function feedbackProfileUrl(username) {
  const query = new URLSearchParams({
    filter: 'feedback_page:RECEIVED_AS_SELLER',
    limit: '200',
    page_id: '1',
    sort: 'TIME'
  });
  return `https://feedback.ebay.com/fdbk/feedback_profile/${encodeURIComponent(username)}?${query}`;
}

function feedbackPageUrl(baseUrl, pageNumber) {
  const url = new URL(baseUrl);
  url.searchParams.set('filter', 'feedback_page:RECEIVED_AS_SELLER');
  url.searchParams.set('limit', '200');
  url.searchParams.set('page_id', String(pageNumber));
  url.searchParams.set('sort', 'TIME');
  return url.toString();
}

async function goto(page, url, options) {
  await navigateWithRetry(page, url);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await handleManualVerification(page, options);
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
}

async function navigateWithRetry(page, url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      return;
    } catch (error) {
      if (!isRetryableNavigationError(error)) throw error;
      await page.waitForTimeout(1200 + attempt * 1000).catch(() => {});
    }
  }

  throw new Error(
    `eBay aborted navigation to ${url}. This is usually a temporary redirect/login timing issue. Try the scrape again, and keep the saved-session Chromium window open.`
  );
}

function isRetryableNavigationError(error) {
  const message = String(error?.message || error || '');
  return /net::ERR_ABORTED|Navigation failed because page was closed|page is navigating/i.test(message);
}

async function readStableContent(page) {
  let lastError;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      return await page.content();
    } catch (error) {
      lastError = error;
      if (!String(error.message || '').includes('page is navigating')) throw error;
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000 + attempt * 500);
    }
  }

  throw lastError;
}

async function handleManualVerification(page, { allowManualVerification, warnings }) {
  if (!(await isVerificationPage(page))) return;

  if (!allowManualVerification) {
    throw new Error('eBay is asking for verification. Enable manual verification and run the scrape again.');
  }

  const url = page.url();
  console.log('eBay verification is open in Chromium. Solve it there; scraping will continue afterward.');
  warnings.push('eBay asked for verification during the scrape, so the browser paused for you to solve it.');

  try {
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText?.toLowerCase() || '';
        const title = document.title.toLowerCase();
        return !(
          title.includes('verify') ||
          title.includes('security measure') ||
          text.includes('please verify') ||
          text.includes('verify yourself') ||
          text.includes('not a robot') ||
          text.includes('security measure')
        );
      },
      undefined,
      { timeout: 10 * 60 * 1000 }
    );
    await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1000);
  } catch {
    throw new Error(`Timed out waiting for eBay verification to be solved: ${url}`);
  }
}

async function isVerificationPage(page) {
  const title = (await page.title().catch(() => '')).toLowerCase();
  const bodyText = (await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')).toLowerCase();
  return (
    title.includes('verify') ||
    title.includes('security measure') ||
    bodyText.includes('please verify') ||
    bodyText.includes('verify yourself') ||
    bodyText.includes('not a robot') ||
    bodyText.includes('security measure')
  );
}

function normalizeUrl(value) {
  try {
    const url = new URL(value.trim());
    if (!/ebay\./i.test(url.hostname)) throw new Error();
    return url.toString();
  } catch {
    throw new Error('Enter a valid eBay URL.');
  }
}

function inferMode(url) {
  if (/\/usr\/|\/fdbk\/feedback_profile\//i.test(url)) return 'seller';
  return /\/str\/|stores\.ebay\.|_sop=|_dmd=|sch\/i\.html/i.test(url) && !/\/itm\//i.test(url)
    ? 'store'
    : 'listing';
}

function extractSellerUsernameFromUrl(value = '') {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/(?:usr|fdbk\/feedback_profile)\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

function extractItemId(value = '') {
  return (
    value.match(/\/itm\/(?:[^/?#]+\/)?(\d{9,})/i)?.[1] ||
    value.match(/[?&](?:item|itemId)=(\d{9,})/i)?.[1] ||
    value.match(/[?&]itm(?:n|=)(\d{9,})/i)?.[1] ||
    value.match(/\(#\s*(\d{9,15})\s*\)/i)?.[1] ||
    value.match(/\b(\d{12})\b/)?.[1] ||
    ''
  );
}

function looksLikeFeedback(text) {
  return /\b(positive|negative|neutral|feedback|seller|buyer|item|arrived|shipping|thanks|great|excellent)\b/i.test(text);
}

function inferRating(text) {
  if (/\bnegative\b/i.test(text)) return 'negative';
  if (/\bneutral\b/i.test(text)) return 'neutral';
  if (/\bpositive\b/i.test(text)) return 'positive';
  return '';
}

function normalizeRating(text = '') {
  const normalized = String(text).toLowerCase();
  if (normalized.includes('negative')) return 'negative';
  if (normalized.includes('neutral')) return 'neutral';
  if (normalized.includes('positive')) return 'positive';
  return inferRating(text);
}

function normalizeFeedbackFrom(text = '') {
  return cleanText(text)
    .replace(/^Buyer:\s*/i, '')
    .replace(/^eBay automated feedback$/i, 'eBay automated feedback')
    .replace(/\s*Verified purchase\s*/i, '')
    .replace(/\s*\([^)]*\).*$/, '')
    .replace(/\s*US\s*\$.*$/i, '')
    .trim();
}

function isFeedbackLeftForSeller(text = '') {
  return /^Seller:/i.test(cleanText(text));
}

function isNonReviewFeedbackText(text = '') {
  const normalized = cleanText(text);
  return (
    /^positive feedback rating$/i.test(normalized) ||
    /^neutral feedback rating$/i.test(normalized) ||
    /^negative feedback rating$/i.test(normalized) ||
    /Detailed seller ratings\s+Average for the last 12 months/i.test(normalized) ||
    /Accurate description\s*\d(?:\.\d)?\s*Reasonable shipping cost/i.test(normalized)
  );
}

function isPageChrome(text = '') {
  const normalized = cleanText(text);
  return (
    normalized.length > 1200 ||
    /All received FeedbackReceived as buyerReceived as sellerLeft for others/i.test(normalized) ||
    /Page \d+ of \d+Results Pagination/i.test(normalized) ||
    /Items per page:2550100200/i.test(normalized)
  );
}

function throwIfEbayErrorPage(html = '', url = '') {
  if (!isEbayErrorPageHtml(html)) return;

  const itemId = extractItemId(url);
  if (itemId) {
    throw new Error(
      `eBay returned an error page for item ${itemId}, so the scraper could not read the seller from that listing. If the listing opens for you in a normal browser, paste the seller profile URL instead, for example https://www.ebay.com/usr/SELLERNAME.`
    );
  }

  throw new Error(
    `eBay returned an error page for ${url}. Open the listing in a normal browser to confirm it is still available, then try the canonical item URL without tracking parameters.`
  );
}

async function handleEbayErrorPage(page, html = '', url = '', options = {}) {
  if (!isEbayErrorPageHtml(html)) return html;

  if (!options.allowManualVerification) {
    throwIfEbayErrorPage(html, url);
  }

  const refreshedHtml = await refreshEbayErrorPage(page, html);
  if (!isEbayErrorPageHtml(refreshedHtml)) {
    options.warnings.push('eBay returned a temporary error page; the scraper refreshed it and continued.');
    return refreshedHtml;
  }

  console.log('eBay returned an error page in Chromium. Refresh or navigate to the working listing page; scraping will continue afterward.');
  options.warnings.push('eBay returned an error page, so the browser paused for manual recovery. Refresh or navigate to the working eBay page in Chromium.');

  try {
    await page.waitForFunction(
      () => {
        const title = document.title || '';
        const body = document.body?.innerText || '';
        return !(
          /Error Page \| eBay/i.test(title) ||
          (/^SORRY\s+Something went wrong on our end/i.test(body.replace(/\s+/g, ' ')) &&
            /go to eBay Homepage/i.test(body))
        );
      },
      undefined,
      { timeout: 10 * 60 * 1000 }
    );
    await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const recoveredHtml = await readStableContent(page);
    throwIfEbayErrorPage(recoveredHtml, url);
    return recoveredHtml;
  } catch {
    throwIfEbayErrorPage(await readStableContent(page).catch(() => html), url);
  }
}

async function refreshEbayErrorPage(page, fallbackHtml) {
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1000);
    return await readStableContent(page);
  } catch {
    return fallbackHtml;
  }
}

function isEbayErrorPageHtml(html = '') {
  const $ = cheerio.load(html);
  const title = cleanText($('title').first().text());
  const body = cleanText($('body').text());

  return (
    /Error Page \| eBay/i.test(title) ||
    (/^SORRY Something went wrong on our end/i.test(body) && /go to eBay Homepage/i.test(body))
  );
}

function normalizeScrapeError(error) {
  const message = String(error?.message || error || '');

  if (/Target page, context or browser has been closed/i.test(message)) {
    return new Error(
      'The eBay browser window was closed while the scrape was still running. Start the scrape again and keep the Chromium window open until the CSV table finishes loading.'
    );
  }

  if (/net::ERR_ABORTED/i.test(message)) {
    return new Error(
      'eBay aborted a page navigation, usually because the saved login session was still redirecting. Run the scrape again and keep the Chromium window open.'
    );
  }

  return error;
}

function extractDate(text) {
  return text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i)?.[0] || '';
}

function extractRelativeDate(text = '') {
  return (
    extractDate(text) ||
    cleanText(text).match(/\bPast\s+(?:month|6 months|year|\d+\s+(?:days?|weeks?|months?|years?))\b/i)?.[0] ||
    ''
  );
}

function extractFeedbackId(text = '') {
  return (
    String(text).match(/\bfeedback[_ -]?id["'=:\s]+(\d{8,})\b/i)?.[1] ||
    String(text).match(/\bdata-feedback-id["'=:\s]+(\d{8,})\b/i)?.[1] ||
    ''
  );
}

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = [
      row.feedback_id,
      row.seller_username,
      row.matched_item_id,
      row.buyer_username,
      row.feedback_date,
      row.feedback_text
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function absoluteUrl(href, base = 'https://www.ebay.com') {
  if (!href) return '';
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}

function stripTracking(url) {
  const parsed = new URL(url);
  for (const key of [...parsed.searchParams.keys()]) {
    if (!['itm', 'hash'].includes(key)) parsed.searchParams.delete(key);
  }
  parsed.hash = '';
  return parsed.toString();
}

function cleanText(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeForMatch(value = '') {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9 ]/g, '');
}

export const scraperInternals = {
  extractSellerUsernameFromUrl,
  inferMode,
  throwIfEbayErrorPage,
  isEbayErrorPageHtml,
  feedbackPageUrl,
  extractFeedbackTotalPages,
  parseListingPageFeedbackRows,
  extractFeedbackImageUrls,
  normalizeFeedbackFrom,
  browserLaunchMode,
  isLoggedOutEbayPage,
  isRetryableNavigationError,
  normalizeScrapeError
};
