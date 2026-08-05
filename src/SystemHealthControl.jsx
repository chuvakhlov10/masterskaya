import { useEffect, useState } from "react";
import { APP_VERSION } from "./status-core.js";
import { checkServerHealth, healthErrorText } from "./server-health.js";

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

function ServiceCard({ title, service }) {
  const state = serviceState(service);
  return (
    <div style={{ background: palette.panel2, border: `1px solid ${palette.border}`, borderRadius: 10, padding: 14, marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 900 }}>{title}</div>
        <div style={{ color: state.color, fontSize: 12, fontWeight: 900 }}>{state.label}</div>
      </div>
      {service?.ok ? (
        <div style={{ color: palette.sub, fontSize: 12, lineHeight: 1.65, marginTop: 8 }}>
          Версия: <b style={{ color: palette.text }}>{service.version}</b><br/>
          Протокол: <b style={{ color: palette.text }}>{service.protocolVersion ?? "—"}</b><br/>
          Сборка: <b style={{ color: palette.text }}>{service.buildId || "—"}</b><br/>
          Дата сборки: <b style={{ color: palette.text }}>{formatDate(service.buildDate)}</b>
        </div>
      ) : (
        <div style={{ color: "#fca5a5", fontSize: 12, fontWeight: 800, lineHeight: 1.5, marginTop: 8 }}>
          {healthErrorText(service?.error)}
        </div>
      )}
    </div>
  );
}

export default function SystemHealthControl() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setResult(await checkServerHealth());
    } catch (cause) {
      setError(healthErrorText(cause?.code || cause?.message));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && !result && !loading) refresh();
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Состояние серверов"
        style={{ position: "fixed", right: 12, top: 112, zIndex: 100050, ...buttonStyle, background: "rgba(27,31,39,.96)", color: palette.text, border: `1px solid ${palette.border}`, boxShadow: "0 7px 22px rgba(0,0,0,.35)" }}
      >
        Система
      </button>

      {open && (
        <div onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 100210, background: "rgba(0,0,0,.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 14, fontFamily: "system-ui, sans-serif" }}>
          <div style={{ width: "100%", maxWidth: 500, maxHeight: "calc(100vh - 28px)", overflow: "auto", background: palette.panel, color: palette.text, border: `1px solid ${palette.border}`, borderRadius: 14, boxShadow: "0 24px 70px rgba(0,0,0,.55)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 18px", borderBottom: `1px solid ${palette.border}` }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>Система</div>
                <div style={{ color: palette.sub, fontSize: 11, marginTop: 3 }}>Приложение и серверные функции</div>
              </div>
              <button onClick={() => setOpen(false)} style={{ border: 0, background: "transparent", color: palette.sub, fontSize: 25, cursor: "pointer", lineHeight: 1 }}>×</button>
            </div>

            <div style={{ padding: 18 }}>
              <div style={{ background: palette.panel2, border: `1px solid ${palette.border}`, borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 14, fontWeight: 900 }}>Приложение</div>
                <div style={{ color: palette.sub, fontSize: 12, marginTop: 7 }}>Версия: <b style={{ color: palette.text }}>{APP_VERSION}</b></div>
              </div>

              {result && <ServiceCard title="Хранилище" service={result.storage} />}
              {result && <ServiceCard title="Live-синхронизация" service={result.ably} />}

              {result?.session && (
                <div style={{ color: palette.sub, fontSize: 11, lineHeight: 1.6, marginTop: 12 }}>
                  Сессия устройства действует до: <b style={{ color: palette.text }}>{formatDate(result.session.expiresAt)}</b><br/>
                  Последняя проверка: <b style={{ color: palette.text }}>{formatDate(result.checkedAt)}</b>
                </div>
              )}

              {error && <div style={{ color: "#fca5a5", fontSize: 12, fontWeight: 800, marginTop: 12 }}>{error}</div>}

              <button
                onClick={refresh}
                disabled={loading}
                style={{ ...buttonStyle, width: "100%", marginTop: 16, padding: "12px 0", border: 0, color: "#fff", background: palette.accent, opacity: loading ? .6 : 1 }}
              >
                {loading ? "Проверка..." : "Проверить снова"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
