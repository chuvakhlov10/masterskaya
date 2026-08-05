import { useEffect, useMemo, useState } from "react";
import {
  createPairingCode,
  hasActivePairingSession,
  inferDeviceName,
  listDevices,
  normalizePairingCode,
  pairingErrorText,
  readDeviceName,
  redeemPairingCode,
  renameDevice,
  revokeDevice,
} from "./device-pairing-client.js";

const palette = {
  bg: "#111318",
  panel: "#1b1f27",
  panel2: "#242a34",
  border: "#343c49",
  text: "#f5f7fa",
  sub: "#a7b0be",
  accent: "#3b82f6",
  accent2: "#1d4ed8",
  danger: "#dc2626",
  success: "#16a34a",
};

const buttonStyle = {
  border: 0,
  borderRadius: 8,
  padding: "11px 14px",
  fontSize: 13,
  fontWeight: 800,
  cursor: "pointer",
};

function formatSeen(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "нет данных";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function remainingText(expiresAt, now) {
  const seconds = Math.max(0, Math.ceil((Number(expiresAt) - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function NewDeviceScreen({ onEmergency }) {
  const [deviceName, setDeviceName] = useState(() => readDeviceName());
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function connect() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await redeemPairingCode({ code, deviceName });
      globalThis.location?.reload?.();
    } catch (cause) {
      setError(pairingErrorText(cause));
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: palette.bg, color: palette.text, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 390, padding: 24 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ width: 64, height: 64, borderRadius: 14, margin: "0 auto 16px", display: "grid", placeItems: "center", background: palette.accent, fontSize: 30 }}>⌁</div>
          <div style={{ fontSize: 23, fontWeight: 900 }}>Подключить устройство</div>
          <div style={{ marginTop: 8, color: palette.sub, fontSize: 13, lineHeight: 1.5 }}>
            Создайте одноразовый код на уже подключённом ноутбуке или телефоне.
          </div>
        </div>

        <div style={{ background: palette.panel, border: `1px solid ${palette.border}`, borderRadius: 12, padding: 16 }}>
          <label style={{ display: "block", fontSize: 11, fontWeight: 800, color: palette.sub, marginBottom: 7, textTransform: "uppercase", letterSpacing: ".6px" }}>Название устройства</label>
          <input
            value={deviceName}
            onChange={event => setDeviceName(event.target.value.slice(0, 60))}
            placeholder={inferDeviceName()}
            style={{ width: "100%", boxSizing: "border-box", padding: "12px 13px", borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.panel2, color: palette.text, fontSize: 15, outline: "none", marginBottom: 14 }}
          />

          <label style={{ display: "block", fontSize: 11, fontWeight: 800, color: palette.sub, marginBottom: 7, textTransform: "uppercase", letterSpacing: ".6px" }}>Одноразовый код</label>
          <input
            value={code}
            onChange={event => setCode(normalizePairingCode(event.target.value))}
            onKeyDown={event => { if (event.key === "Enter") connect(); }}
            placeholder="XXXX-XXXX-XXXX"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            style={{ width: "100%", boxSizing: "border-box", padding: "13px", borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.panel2, color: palette.text, fontSize: 19, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontWeight: 900, textAlign: "center", letterSpacing: "1.5px", outline: "none" }}
          />

          {error && <div style={{ color: "#fca5a5", fontSize: 12, fontWeight: 800, marginTop: 11, lineHeight: 1.4 }}>{error}</div>}

          <button
            onClick={connect}
            disabled={busy || code.replaceAll("-", "").length !== 12}
            style={{ ...buttonStyle, width: "100%", marginTop: 14, padding: "14px 0", color: "#fff", background: palette.accent, opacity: busy || code.replaceAll("-", "").length !== 12 ? .5 : 1 }}
          >
            {busy ? "Подключение..." : "Подключить"}
          </button>
        </div>

        <div style={{ marginTop: 16, color: palette.sub, fontSize: 12, lineHeight: 1.55 }}>
          На подключённом устройстве откройте кнопку <b style={{ color: palette.text }}>«Устройства»</b> и нажмите <b style={{ color: palette.text }}>«Создать код»</b>. Код действует 10 минут и используется один раз.
        </div>
        <button onClick={onEmergency} style={{ border: 0, background: "transparent", color: palette.sub, fontSize: 11, textDecoration: "underline", cursor: "pointer", padding: "16px 0 0" }}>
          Аварийное восстановление через GitHub
        </button>
      </div>
    </div>
  );
}

function DeviceManager({ open, onClose }) {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pairing, setPairing] = useState(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const current = useMemo(() => devices.find(device => device.current), [devices]);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setDevices(await listDevices());
    } catch (cause) {
      setError(pairingErrorText(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open]);

  useEffect(() => {
    if (!open || !pairing) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, pairing]);

  useEffect(() => {
    if (pairing && pairing.expiresAt <= now) setPairing(null);
  }, [pairing, now]);

  if (!open) return null;

  async function generateCode() {
    setPairingBusy(true);
    setError("");
    try {
      const result = await createPairingCode();
      setPairing(result);
      setNow(Date.now());
    } catch (cause) {
      setError(pairingErrorText(cause));
    } finally {
      setPairingBusy(false);
    }
  }

  async function copyCode() {
    if (!pairing?.code) return;
    try { await navigator.clipboard.writeText(pairing.code); }
    catch {}
  }

  async function rename(item) {
    const next = globalThis.prompt?.("Название устройства", item.name || "Устройство");
    if (!next || next.trim() === item.name) return;
    setError("");
    try {
      await renameDevice(item.id, next.trim());
      await refresh();
    } catch (cause) {
      setError(pairingErrorText(cause));
    }
  }

  async function revoke(item) {
    if (!globalThis.confirm?.(`Отключить устройство «${item.name}»? Оно потеряет доступ к данным и Live-синхронизации.`)) return;
    setError("");
    try {
      await revokeDevice(item.id);
      await refresh();
    } catch (cause) {
      setError(pairingErrorText(cause));
    }
  }

  return (
    <div onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 100200, background: "rgba(0,0,0,.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 14, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 520, maxHeight: "calc(100vh - 28px)", overflow: "auto", background: palette.panel, color: palette.text, border: `1px solid ${palette.border}`, borderRadius: 14, boxShadow: "0 24px 70px rgba(0,0,0,.55)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 18px", borderBottom: `1px solid ${palette.border}` }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>Устройства</div>
            <div style={{ color: palette.sub, fontSize: 11, marginTop: 3 }}>{current ? `Это устройство: ${current.name}` : "Управление доступом"}</div>
          </div>
          <button onClick={onClose} style={{ border: 0, background: "transparent", color: palette.sub, fontSize: 25, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: 18 }}>
          <button onClick={generateCode} disabled={pairingBusy} style={{ ...buttonStyle, width: "100%", background: palette.accent, color: "#fff", opacity: pairingBusy ? .6 : 1 }}>
            {pairingBusy ? "Создание кода..." : "Подключить новое устройство"}
          </button>

          {pairing && (
            <div style={{ marginTop: 12, padding: 15, borderRadius: 10, background: "#10233f", border: "1px solid #24569a", textAlign: "center" }}>
              <div style={{ color: "#bfdbfe", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".7px" }}>Одноразовый код</div>
              <div style={{ marginTop: 7, fontSize: 25, fontWeight: 900, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", letterSpacing: "2px" }}>{pairing.code}</div>
              <div style={{ color: "#bfdbfe", fontSize: 12, marginTop: 7 }}>Действует ещё {remainingText(pairing.expiresAt, now)}</div>
              <button onClick={copyCode} style={{ ...buttonStyle, marginTop: 10, background: palette.panel2, color: palette.text }}>Копировать код</button>
            </div>
          )}

          {error && <div style={{ color: "#fca5a5", fontSize: 12, fontWeight: 800, marginTop: 12 }}>{error}</div>}

          <div style={{ marginTop: 20, fontSize: 11, fontWeight: 900, color: palette.sub, textTransform: "uppercase", letterSpacing: ".7px" }}>Подключённые устройства</div>
          {loading && <div style={{ padding: "16px 0", color: palette.sub, fontSize: 13 }}>Загрузка...</div>}
          {!loading && devices.map(item => (
            <div key={item.id} style={{ marginTop: 10, padding: 13, borderRadius: 10, border: `1px solid ${item.revokedAt ? "#5b2a2a" : palette.border}`, background: palette.panel2, opacity: item.revokedAt ? .65 : 1 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {item.name || "Устройство"}{item.current ? " · текущее" : ""}
                  </div>
                  <div style={{ color: palette.sub, fontSize: 11, marginTop: 5 }}>
                    Последняя активность: {formatSeen(item.lastSeenAt)}{item.revokedAt ? " · отключено" : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 7, flexShrink: 0 }}>
                  {!item.revokedAt && <button onClick={() => rename(item)} style={{ ...buttonStyle, padding: "7px 9px", background: "#374151", color: palette.text, fontSize: 11 }}>Имя</button>}
                  {!item.current && !item.revokedAt && <button onClick={() => revoke(item)} style={{ ...buttonStyle, padding: "7px 9px", background: palette.danger, color: "#fff", fontSize: 11 }}>Отключить</button>}
                </div>
              </div>
            </div>
          ))}
          {!loading && devices.length === 0 && !error && <div style={{ padding: "16px 0", color: palette.sub, fontSize: 13 }}>Устройства не найдены</div>}
        </div>
      </div>
    </div>
  );
}

export default function DevicePairingGate({ children }) {
  const [emergency, setEmergency] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const connected = hasActivePairingSession();

  if (!connected && !emergency) return <NewDeviceScreen onEmergency={() => setEmergency(true)} />;

  return (
    <>
      {children}
      {connected && (
        <button
          onClick={() => setManagerOpen(true)}
          title="Подключённые устройства"
          style={{ position: "fixed", right: 12, top: 68, zIndex: 100050, ...buttonStyle, padding: "9px 11px", background: "rgba(27,31,39,.96)", color: palette.text, border: `1px solid ${palette.border}`, boxShadow: "0 7px 22px rgba(0,0,0,.35)" }}
        >
          Устройства
        </button>
      )}
      <DeviceManager open={managerOpen} onClose={() => setManagerOpen(false)} />
    </>
  );
}
