export const APP_VERSION = "1.3.3";

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

function operationWord(value) {
  const number = Math.abs(nonNegativeInt(value));
  const mod100 = number % 100;
  const mod10 = number % 10;
  if (mod100 >= 11 && mod100 <= 14) return "операций";
  if (mod10 === 1) return "операция";
  if (mod10 >= 2 && mod10 <= 4) return "операции";
  return "операций";
}

function operationCount(value) {
  const pending = nonNegativeInt(value);
  return `${pending} ${operationWord(pending)}`;
}

export function normalizeBackupStatus(raw) {
  const attempt = raw && typeof raw === "object" ? raw.last_attempt : null;
  const latest = raw && typeof raw === "object" ? raw.latest_good : null;
  const countsSource = latest?.counts || attempt?.counts || {};

  return {
    available: !!(attempt || latest),
    valid: attempt?.valid === true && !!latest,
    checkedAt: typeof attempt?.checked_at === "string" ? attempt.checked_at : null,
    backupAt: typeof latest?.created_at === "string" ? latest.created_at : null,
    dailyPath: typeof latest?.daily_path === "string" ? latest.daily_path : null,
    monthlyPath: typeof latest?.monthly_path === "string" ? latest.monthly_path : null,
    counts: {
      records: nonNegativeInt(countsSource.records),
      stockOps: nonNegativeInt(countsSource.stock_ops),
      recordDeletions: nonNegativeInt(countsSource.record_deletions),
      recordEffectOps: nonNegativeInt(countsSource.record_effect_ops),
    },
    errors: stringList(attempt?.errors),
    warnings: stringList(attempt?.warnings),
  };
}

export function deriveSyncView({ online, syncStatus, pendingCount, lastError, busy }) {
  const pending = nonNegativeInt(pendingCount);

  if (!online) {
    return {
      kind: "offline",
      icon: "📴",
      label: pending > 0 ? `Офлайн · ожидает отправки: ${operationCount(pending)}` : "Офлайн",
    };
  }

  if (lastError) {
    return {
      kind: "error",
      icon: "⚠",
      label: pending > 0 ? `Ошибка · ожидает отправки: ${operationCount(pending)}` : "Ошибка синхронизации",
    };
  }

  if (busy || syncStatus === "syncing" || pending > 0) {
    return {
      kind: "sending",
      icon: "↻",
      label: pending > 0 ? `Отправляется · осталось: ${operationCount(pending)}` : "Обновление...",
    };
  }

  if (syncStatus === "ws") {
    return { kind: "live", icon: "⚡", label: "Сохранено · Live" };
  }

  if (syncStatus === "synced") {
    return { kind: "saved", icon: "✓", label: "Сохранено" };
  }

  return { kind: "sending", icon: "…", label: "Проверка..." };
}
