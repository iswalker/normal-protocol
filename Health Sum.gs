/***************
 * CONFIG
 ***************/

const YNAB_API_BASE = 'https://api.ynab.com/v1';

// Use "last-used" unless you want to hard-code a specific budget ID.
const YNAB_BUDGET_ID = 'last-used';


/**
 * Run this once from Apps Script editor to save your YNAB API token.
 * Do NOT put your API key directly in a spreadsheet cell.
 */
function setYnabApiToken() {
  const token = Browser.inputBox('Enter YNAB API Token');
  if (!token || token === 'cancel') return;

  PropertiesService.getScriptProperties().setProperty('YNAB_API_TOKEN', token);
  Browser.msgBox('YNAB API token saved.');
}


/**
 * Spreadsheet formula:
 *
 * =YNAB_CATEGORY_GROUP_SPENT("May 2026", "Health")
 *
 * Optional, include scheduled transactions whose next date falls inside that month:
 *
 * =YNAB_CATEGORY_GROUP_SPENT("May 2026", "Health", TRUE)
 *
 * Optional:
 *
 * =YNAB_CATEGORY_GROUP_SPENT("2026-05", "Health", TRUE)
 *
 * Returns net YNAB activity for that category group.
 * Outflows are negative, inflows/refunds are positive.
 *
 * Example:
 *   Spending $1,795.87 with no refunds returns -1795.87.
 */
function YNAB_CATEGORY_GROUP_SPENT(monthInput, categoryGroupName, includeScheduled, refreshKey) {
  if (!monthInput) throw new Error('Missing month input. Example: "May 2026" or "2026-05".');
  if (!categoryGroupName) categoryGroupName = 'Health';

  // In Sheets, TRUE comes through as boolean true.
  // This also supports "TRUE", "true", "yes", or 1 just in case.
  includeScheduled = parseBoolean_(includeScheduled);

  const token = getYnabToken_();
  const monthStart = parseMonthStart_(monthInput);
  const monthEndExclusive = addMonths_(monthStart, 1);

  const startDate = formatDate_(monthStart);
  const endDateExclusive = formatDate_(monthEndExclusive);

  const cacheKey = [
    'YNAB_GROUP_SPENT',
    startDate,
    endDateExclusive,
    String(categoryGroupName).toLowerCase().trim(),
    includeScheduled ? 'includeScheduled' : 'actualOnly'
  ].join('|');

  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached !== null) return Number(cached);

  const categories = fetchYnabCategories_(token);
  const categoryIds = getCategoryIdsForGroup_(categories, categoryGroupName);

  if (categoryIds.length === 0) {
    throw new Error(`No YNAB category group found matching "${categoryGroupName}".`);
  }

  let milliunits = 0;

  // Actual entered transactions.
  const transactions = fetchYnabTransactions_(token, startDate);
  milliunits += sumMatchingTransactions_(
    transactions,
    categoryIds,
    startDate,
    endDateExclusive,
    'date'
  );

  // Future scheduled transactions.
  //
  // Note: this counts scheduled transactions where the scheduled record's date_next
  // falls inside the requested month. For repeating weekly/biweekly scheduled items,
  // YNAB's scheduled transaction record may expose only the next upcoming occurrence,
  // not every future recurrence inside the month.
  if (includeScheduled) {
    const scheduledTransactions = fetchYnabScheduledTransactions_(token);
    milliunits += sumMatchingTransactions_(
      scheduledTransactions,
      categoryIds,
      startDate,
      endDateExclusive,
      'date_next'
    );
  }

  const dollars = milliunits / 1000;

  // Testing cache: 30 seconds. Increase to 600 after you trust the function.
  cache.put(cacheKey, String(dollars), 30);

  return dollars;
}


/**
 * Optional convenience function if you want spending shown as a positive number.
 *
 * =YNAB_CATEGORY_GROUP_SPENT_POSITIVE("May 2026", "Health", TRUE)
 *
 * Example:
 *   Spending $1,795.87 with no refunds returns 1795.87.
 */
function YNAB_CATEGORY_GROUP_SPENT_POSITIVE(monthInput, categoryGroupName, includeScheduled) {
  return YNAB_CATEGORY_GROUP_SPENT(monthInput, categoryGroupName, includeScheduled) * -1;
}


/***************
 * TRANSACTION SUMMING
 ***************/

/**
 * Sums transactions or scheduled transactions for matching category IDs.
 *
 * For normal transactions, dateField should be "date".
 * For scheduled transactions, dateField should be "date_next".
 *
 * This uses YNAB net activity:
 *   Outflows are negative.
 *   Inflows/refunds are positive.
 *
 * For split transactions, it sums only the matching subtransaction amounts,
 * not the parent transaction amount.
 */
function sumMatchingTransactions_(transactions, categoryIds, startDate, endDateExclusive, dateField) {
  let milliunits = 0;

  transactions.forEach(txn => {
    const txnDate = txn[dateField];

    if (!txnDate) return;
    if (txnDate < startDate || txnDate >= endDateExclusive) return;
    if (txn.deleted) return;

    // CASE 1: Split transaction.
    // Sum ONLY the matching split lines.
    if (txn.subtransactions && txn.subtransactions.length > 0) {
      txn.subtransactions.forEach(sub => {
        if (sub.deleted) return;
        if (!sub.category_id) return;
        if (!categoryIds.includes(sub.category_id)) return;

        milliunits += Number(sub.amount || 0);
      });

      return;
    }

    // CASE 2: Normal, non-split transaction.
    if (!txn.category_id) return;
    if (!categoryIds.includes(txn.category_id)) return;

    milliunits += Number(txn.amount || 0);
  });

  return milliunits;
}


/***************
 * YNAB HELPERS
 ***************/

function getYnabToken_() {
  const token = PropertiesService.getScriptProperties().getProperty('YNAB_API_TOKEN');
  if (!token) {
    throw new Error('YNAB API token not set. Run setYnabApiToken() once from Apps Script.');
  }
  return token;
}


function ynabFetch_(token, path) {
  const url = `${YNAB_API_BASE}${path}`;

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Authorization: `Bearer ${token}`
    },
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(`YNAB API error ${code}: ${body}`);
  }

  return JSON.parse(body);
}


function fetchYnabCategories_(token) {
  const data = ynabFetch_(token, `/budgets/${YNAB_BUDGET_ID}/categories`);
  return data.data.category_groups || [];
}


function fetchYnabTransactions_(token, sinceDate) {
  const data = ynabFetch_(token, `/budgets/${YNAB_BUDGET_ID}/transactions?since_date=${sinceDate}`);
  return data.data.transactions || [];
}


function fetchYnabScheduledTransactions_(token) {
  const data = ynabFetch_(token, `/budgets/${YNAB_BUDGET_ID}/scheduled_transactions`);
  return data.data.scheduled_transactions || [];
}


function getCategoryIdsForGroup_(categoryGroups, categoryGroupName) {
  const target = normalize_(categoryGroupName);
  const ids = [];

  categoryGroups.forEach(group => {
    if (normalize_(group.name) !== target) return;

    (group.categories || []).forEach(cat => {
      // Include hidden categories so old hidden Health categories still reconcile
      // against YNAB history/reports.
      if (!cat.deleted) {
        ids.push(cat.id);
      }
    });
  });

  return ids;
}


function normalize_(value) {
  return String(value || '').trim().toLowerCase();
}


/***************
 * DATE HELPERS
 ***************/

function parseMonthStart_(monthInput) {
  if (Object.prototype.toString.call(monthInput) === '[object Date]') {
    return new Date(monthInput.getFullYear(), monthInput.getMonth(), 1);
  }

  const raw = String(monthInput).trim();

  // Supports "2026-05"
  const yyyyMm = raw.match(/^(\d{4})-(\d{1,2})$/);
  if (yyyyMm) {
    return new Date(Number(yyyyMm[1]), Number(yyyyMm[2]) - 1, 1);
  }

  // Supports "May 2026"
  const parsed = new Date(`1 ${raw}`);
  if (!isNaN(parsed.getTime())) {
    return new Date(parsed.getFullYear(), parsed.getMonth(), 1);
  }

  throw new Error(`Could not parse month: "${monthInput}". Use "May 2026" or "2026-05".`);
}


function addMonths_(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}


function formatDate_(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}


function parseBoolean_(value) {
  if (value === true) return true;
  if (value === 1) return true;

  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === 'y' || normalized === '1';
}


/***************
 * OPTIONAL TESTS
 ***************/

function testYnabHealthMay2026ActualOnly() {
  const result = YNAB_CATEGORY_GROUP_SPENT('May 2026', 'Health', false);
  Logger.log(result);
}


function testYnabHealthMay2026IncludingScheduled() {
  const result = YNAB_CATEGORY_GROUP_SPENT('May 2026', 'Health', true);
  Logger.log(result);
}
