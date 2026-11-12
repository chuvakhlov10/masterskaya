export const PAYMENT_METHODS = [
  ["cash", "Наличные"], ["card", "Карта"], ["qr", "QR-код"],
];
export const UNSPECIFIED_PAYMENT = "Способ оплаты не указан";

export function usesPaymentMethods(workshop) {
  return workshop === "SMART";
}

// Calculate in kopecks: a split must balance exactly, including decimal amounts.
export function moneyCents(value) {
  if (typeof value === "number") {
    const cents = Math.round(value * 100);
    return value >= 0 && Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) < 0.000001 ? cents : null;
  }
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function buildPayments(draft, amount, allowUnspecified = false) {
  const total = moneyCents(amount);
  if (total === null) return { error:"Укажите корректную сумму с точностью до копеек" };
  if (total === 0) return { payments:[] };
  if (!draft.method && allowUnspecified) return { payments:[] };
  if (PAYMENT_METHODS.some(([id]) => id === draft.method)) {
    return { payments:[{ method:draft.method, amount:total / 100 }] };
  }
  if (draft.method !== "split") return { error:"Выберите способ оплаты" };
  const parts = PAYMENT_METHODS.map(([method]) => ({
    method, cents:moneyCents(draft[method] === "" ? 0 : draft[method]),
  }));
  if (parts.some(part => part.cents === null)) {
    return { error:"Суммы оплаты должны быть неотрицательными, с точностью до копеек" };
  }
  const sum = parts.reduce((value, part) => value + part.cents, 0);
  if (sum !== total) return { error:"Суммы по способам оплаты должны совпадать с суммой записи" };
  const payments = parts.filter(part => part.cents > 0)
    .map(({ method, cents }) => ({ method, amount:cents / 100 }));
  if (payments.length < 2) return { error:"Для смешанной оплаты укажите хотя бы два способа" };
  return { payments };
}

export function recordPayments(record) {
  if (!Array.isArray(record.payments) || !record.payments.length) return [];
  const seen = new Set();
  let sum = 0;
  for (const part of record.payments) {
    if (!part || !PAYMENT_METHODS.some(([id]) => id === part.method) || seen.has(part.method)) return [];
    const cents = moneyCents(part.amount);
    if (cents === null || cents <= 0) return [];
    sum += cents;
    seen.add(part.method);
  }
  return sum === moneyCents(record.amount) ? record.payments : [];
}

export function paymentDraft(record = {}) {
  const parts = recordPayments(record);
  return {
    method:parts.length > 1 ? "split" : parts[0]?.method || "",
    ...Object.fromEntries(PAYMENT_METHODS.map(([id]) => [id, String(parts.find(p => p.method === id)?.amount ?? "")])),
  };
}

const formatMoney = value => new Intl.NumberFormat("ru-RU", { maximumFractionDigits:2 }).format(value);
export function paymentLabel(record) {
  const parts = recordPayments(record);
  if (!parts.length) return UNSPECIFIED_PAYMENT;
  return parts.map(part => {
    const label = PAYMENT_METHODS.find(([id]) => id === part.method)[1];
    return parts.length === 1 ? label : `${label}: ${formatMoney(part.amount)} ₽`;
  }).join(" · ");
}

export function paymentTotals(records) {
  const totals = { cash:0, card:0, qr:0, unspecified:0 };
  for (const record of records) {
    const sign = record.recordType === "refund" ? -1 : 1;
    const parts = recordPayments(record);
    if (!parts.length) totals.unspecified += sign * (moneyCents(record.amount) ?? 0);
    else for (const part of parts) totals[part.method] += sign * moneyCents(part.amount);
  }
  return Object.fromEntries(Object.entries(totals).map(([id, cents]) => [id, cents / 100]));
}
