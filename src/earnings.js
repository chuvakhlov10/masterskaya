// The agreed rate follows the original record date in the workshop's time zone,
// so editing an old record or opening it on another device cannot change it.
const RATE_CHANGE_AT = Date.parse("2026-11-01T00:00:00+03:00");
const SHARPING_MARKERS = new Set([
  "Заточка ножей", "Заточка топоров", "Заточка садового инструмента", "Заточка топора",
]);

export function regularIncomeRate(timestamp) {
  const date = Number(timestamp);
  return Number.isFinite(date) && date >= RATE_CHANGE_AT ? 0.45 : 0.4;
}

export function calcEarnings(records) {
  let fromKeys = 0;
  let fromSharping = 0;
  let total = 0;
  for (const record of records) {
    const amount = (record.amount || 0) * (record.recordType === "refund" ? -1 : 1);
    if (SHARPING_MARKERS.has(record.marker)) {
      total += amount;
      fromSharping += amount;
    } else {
      const earnings = amount * regularIncomeRate(record.timestamp);
      total += earnings;
      fromKeys += earnings;
    }
  }
  return { total, fromKeys, fromSharping };
}
