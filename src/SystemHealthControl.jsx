import { useEffect, useState } from "react";
import { backupStatusGet } from "./github-storage.js";
import { APP_VERSION, normalizeBackupStatus } from "./status-core.js";
import { checkServerHealth, healthErrorText } from "./server-health.js";
import {
  buildDiagnosticReport,
  collectClientDiagnostics,
} from "./diagnostics.js";

const palette = {
  panel: "#1b1f27",
  panel2: "#242a34",
  border: "#343c49",
  text: "#f5f7fa",
  sub: "#a7b0be",
  accent: "#3b82f6",
  danger: "#dc2626",
  success: "#16a34a",
  warning: "#d97706",
};

const buttonStyle = {
  borderRadius: 8,
  padding: "9px 11px",
  fontSize: 13,
  fontWeight: 800,
  cursor: "pointer",
};

function formatDate(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "нет данных";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function serviceState(service) {
  if (!service?.ok) return { label: "Ошибка", color: palette.danger };
  const values = Object.values(service.checks || {});
  if (values.some(value => value === "missing" || value === "error" || value === "unavailable")) {
    return { label: "Требует внимания", color: palette.warning };
  }
  return { label: "Работает", color: palette.success };
}

function Card({ title, status, statusColor, children }) {
  return (
    <div style={{ background: palette.panel2, border: `1px solid ${palette.border}`, borderRadius: 10, padding: 14, marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 900 }}>{title}</div>
        {status && <div style={{ color: statusColor || palette.sub, fontSize: 12, fontWeight: 900 }}>{status}</div>}
      </div>
      <div style={{ color: palette.sub, fontSize: 12, lineHeight: 1.7, marginTop: 8 }}>{children}</div>
    </div>
  );
}

function Row({ label, value, valueColor = palette.text }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginTop: 3 }}>
      <span>{label}</span>
      <b style={{ color: valueColor, textAlign: "right", overflowWrap: "anywhere" }}>{value}</b>
    </div>
  );
}

function ServiceCard({ title, service }) {
  const state = serviceState(service);
  return (
    <Card title={title} status={state.label} statusColor={state.color}>
      {service?.ok ? (
        <>
          <Row label="Версия" value={service.version} />
          <Row label="Протокол" value={service.protocolVersion ?? "—"} />
          <Row label="Сборка" value={service.buildId || "—"} />
          <Row label="Дата сборки" value={formatDate(service.buildDate)} />
        </>
      ) : (
        <div style={{ color: "#fca5a5", fontWeight: 800 }}>{healthErrorText(service?.error)}</div>
      )}
    </Card>
  );
}

async function copyText(text) {
  if (globalThis.navigator?.clipboard?.writeText) {
    await globalThis.navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document === "undefined") throw new Error("CLIPBOARD_UNAVAILABLE");
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy");
  textarea.remove();
  if (!copied) throw new Error("CLIPBOARD_UNAVAILABLE");
}

export default function SystemHealthControl() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function refresh() {
    setLoading(true);
    setError("");
    setCopied(false);
    try {
      const health = await checkServerHealth();
      let backup = normalizeBackupStatus(null);
      let backupError = "";
      if (globalThis.navigator?.onLine !== false) {
        try { backup = normalizeBackupStatus(await backupStatusGet()); }
        catch (cause) { backupError = String(cause?.message || "BACKUP_STATUS_FAILED"); }
      }
      const client = await collectClientDiagnostics({ health, backup });
      setResult({ health, backup, backupError, client });
    } catch (cause) {
      setError(healthErrorText(cause?.code || cause?.message));
    } finally {
      setLoading(false);
    }
  }

  async function copyDiagnostics() {
    if (!result?.client) return;
    setCopied(false);
    setError("");
    try {
      await copyText(buildDiagnosticReport(result.client, APP_VERSION));
      setCopied(true);
      setTimeout(() => setCopied(false), 3_000);
    } catch {
      setError("Не удалось скопировать диагностику");
    }
  }

  useEffect(() => {
    if (open && !result && !loading) refresh();
  }, [open]);

  useEffect(() => {
    if (!open || !result) return undefined;
    let cancelled = false;
    const updateLocalState = async () => {
      const client = await collectClientDiagnostics({ health: result.health, backup: result.backup });
      if (!cancelled) setResult(previous => previous ? { ...previous, client } : previous);
    };
    const timer = setInterval(updateLocalState, 2_000);
    const onConnectivity = () => updateLocalState();
    globalThis.addEventListener?.("online", onConnectivity);
    globalThis.addEventListener?.("offline", onConnectivity);
    return () => {
      cancelled = true;
      clearInterval(timer);
      globalThis.removeEventListener?.("online", onConnectivity);
      globalThis.removeEventListener?.("offline", onConnectivity);
    };
  }, [open, result?.health, result?.backup]);

  const client = result?.client;
  const queues = client?.sync?.queues;
  const backup = result?.backup;
  const backupState = backup?.valid
    ? { label: "В порядке", color: palette.success }
    : backup?.available
      ? { label: "Требует внимания", color: palette.warning }
      : { label: "Нет данных", color: palette.sub };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Состояние серверов и диагностика"
        style={{ position: "fixed", right: 12, top: 112, zIndex: 100050, ...buttonStyle, background: "rgba(27,31,39,.96)", color: palette.text, border: `1px solid ${palette.border}`, boxShadow: "0 7px 22px rgba(0,0,0,.35)" }}
      >
        Система
      </button>

      {open && (
        <div onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 100210, background: "rgba(0,0,0,.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 14, fontFamily: "system-ui, sans-serif" }}>
          <div style={{ width: "100%", maxWidth: 570, maxHeight: "calc(100vh - 28px)", overflow: "auto", background: palette.panel, color: palette.text, border: `1px solid ${palette.border}`, borderRadius: 14, boxShadow: "0 24px 70px rgba(0,0,0,.55)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 18px", borderBottom: `1px solid ${palette.border}` }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>Система</div>
                <div style={{ color: palette.sub, fontSize: 11, marginTop: 3 }}>Безопасная диагностика приложения</div>
              </div>
              <button onClick={() => setOpen(false)} style={{ border: 0, background: "transparent", color: palette.sub, fontSize: 25, cursor: "pointer", lineHeight: 1 }}>×</button>
            </div>

            <div style={{ padding: 18 }}>
              <Card title="Приложение" status={client?.online === false ? "Офлайн" : "Онлайн"} statusColor={client?.online === false ? palette.warning : palette.success}>
                <Row label="Версия" value={APP_VERSION} />
                <Row label="Диагностика обновлена" value={formatDate(client?.collectedAt)} />
              </Card>

              {result?.health && <ServiceCard title="Хранилище" service={result.health.storage} />}
              {result?.health && <ServiceCard title="Live-синхронизация" service={result.health.ably} />}

              {client && (
                <Card title="Текущее устройство">
                  <Row label="Название" value={client.device.name} />
                  <Row label="ID" value={client.device.clientIdMasked} />
                  <Row label="Сессия действует до" value={formatDate(client.device.sessionExpiresAt)} />
                  <Row label="Последнее продление" value={formatDate(client.storage.lastSessionRenewedAt)} />
                </Card>
              )}

              {client && (
                <Card title="Синхронизация" status={client.sync.label} statusColor={queues?.totalOperations ? palette.warning : palette.success}>
                  <Row label="Операции данных" value={queues?.dataOperations ?? 0} valueColor={queues?.dataOperations ? palette.warning : palette.text} />
                  <Row label="Складские операции" value={queues?.stockOperations ?? 0} valueColor={queues?.stockOperations ? palette.warning : palette.text} />
                  <Row label="Всего ожидает отправки" value={queues?.totalOperations ?? 0} valueColor={queues?.totalOperations ? palette.warning : palette.text} />
                  <Row label="Последняя успешная синхронизация" value={formatDate(client.sync.lastSuccessfulAt)} />
                </Card>
              )}

              {client && (
                <Card title="Запросы к хранилищу" status={client.storage.lastStorageErrorCode ? "Есть журнал ошибки" : "Без ошибок"} statusColor={client.storage.lastStorageErrorCode ? palette.warning : palette.success}>
                  <Row label="Последний успешный запрос" value={formatDate(client.storage.lastStorageSuccessAt)} />
                  <Row label="Последняя операция" value={client.storage.lastStorageOperation || "нет данных"} />
                  <Row label="Последняя ошибка" value={client.storage.lastStorageErrorCode || "нет"} valueColor={client.storage.lastStorageErrorCode ? "#fca5a5" : palette.text} />
                  <Row label="Время ошибки" value={formatDate(client.storage.lastStorageErrorAt)} />
                  <Row label="Повторов в последнем запросе" value={client.storage.lastStorageRetries} />
                  <Row label="Повторов всего" value={client.storage.totalStorageRetries} />
                </Card>
              )}

              {backup && (
                <Card title="Резервная копия" status={backupState.label} statusColor={backupState.color}>
                  <Row label="Дата копии" value={formatDate(backup.backupAt)} />
                  <Row label="Записей" value={backup.counts.records} />
                  <Row label="Складских операций" value={backup.counts.stockOps} />
                  <Row label="Ошибок" value={backup.errors.length} valueColor={backup.errors.length ? "#fca5a5" : palette.text} />
                  <Row label="Предупреждений" value={backup.warnings.length} valueColor={backup.warnings.length ? palette.warning : palette.text} />
                  {result?.backupError && <div style={{ color: "#fca5a5", fontWeight: 800, marginTop: 7 }}>Не удалось обновить статус: {result.backupError}</div>}
                </Card>
              )}

              {client && (
                <Card title="PWA и кеш">
                  <Row label="Service Worker поддерживается" value={client.pwa.supported ? "Да" : "Нет"} />
                  <Row label="Управляет страницей" value={client.pwa.controlled ? "Да" : "Нет"} />
                  <Row label="Состояние" value={client.pwa.workerState} />
                  <Row label="Ожидает обновления" value={client.pwa.updateWaiting ? "Да" : "Нет"} valueColor={client.pwa.updateWaiting ? palette.warning : palette.text} />
                  <Row label="Кеши" value={client.pwa.cacheNames.join(", ") || "нет данных"} />
                </Card>
              )}

              {error && <div style={{ color: "#fca5a5", fontSize: 12, fontWeight: 800, marginTop: 12 }}>{error}</div>}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginTop: 16 }}>
                <button
                  onClick={refresh}
                  disabled={loading}
                  style={{ ...buttonStyle, padding: "12px 0", border: 0, color: "#fff", background: palette.accent, opacity: loading ? .6 : 1 }}
                >
                  {loading ? "Проверка..." : "Проверить снова"}
                </button>
                <button
                  onClick={copyDiagnostics}
                  disabled={!client}
                  style={{ ...buttonStyle, padding: "12px 0", border: `1px solid ${palette.border}`, color: palette.text, background: palette.panel2, opacity: client ? 1 : .5 }}
                >
                  {copied ? "Скопировано" : "Скопировать диагностику"}
                </button>
              </div>

              <div style={{ color: palette.sub, fontSize: 10, lineHeight: 1.5, marginTop: 11 }}>
                Отчёт не содержит токены, JWT, приватные ключи, фотографии и содержимое рабочих записей.
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
