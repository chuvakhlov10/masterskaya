'use strict';

const crypto = require('node:crypto');

const DEVICE_REGISTRY_PATH = 'auth/devices.json';
const PAIRINGS_PATH = 'auth/pairings.json';
const RECOVERY_STATE_PATH = 'auth/recovery.json';
const PAIRING_TTL_MS = 10 * 60 * 1000;
const RECOVERY_RETRY_GRACE_MS = 10 * 60 * 1000;
const REGISTRY_CACHE_TTL_MS = 30 * 1000;
const LAST_SEEN_WRITE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LENGTH = 12;
const RECOVERY_CODE_LENGTH = 24;

function makeError(code, statusCode = 500, cause) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  if (cause) error.cause = cause;
  return error;
}

function normalizeClientId(value) {
  const clientId = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(clientId) ? clientId : null;
}

function normalizeDeviceName(value, fallback = 'Устройство') {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return normalized || fallback;
}

function normalizePairingCode(value) {
  const normalized = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return new RegExp(`^[${PAIRING_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`).test(normalized) ? normalized : null;
}

function formatPairingCode(value) {
  const code = normalizePairingCode(value);
  if (!code) return '';
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function createPairingCode(randomInt = crypto.randomInt) {
  let result = '';
  for (let index = 0; index < PAIRING_CODE_LENGTH; index++) {
    result += PAIRING_ALPHABET[randomInt(0, PAIRING_ALPHABET.length)];
  }
  return result;
}

function hashPairingCode(value) {
  const code = normalizePairingCode(value);
  if (!code) return null;
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

function normalizeRecoveryCode(value) {
  const normalized = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return new RegExp(`^[${PAIRING_ALPHABET}]{${RECOVERY_CODE_LENGTH}}$`).test(normalized) ? normalized : null;
}

function formatRecoveryCode(value) {
  const code = normalizeRecoveryCode(value);
  if (!code) return '';
  return code.match(/.{1,4}/g).join('-');
}

function createRecoveryCode(randomInt = crypto.randomInt) {
  let result = '';
  for (let index = 0; index < RECOVERY_CODE_LENGTH; index++) {
    result += PAIRING_ALPHABET[randomInt(0, PAIRING_ALPHABET.length)];
  }
  return result;
}

function hashRecoveryCode(value) {
  const code = normalizeRecoveryCode(value);
  if (!code) return null;
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

function deriveReplacementRecoveryCode({ code, clientId, generation, secret }) {
  const normalized = normalizeRecoveryCode(code);
  const id = normalizeClientId(clientId);
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret || ''), 'utf8');
  if (!normalized || !id || key.length < 32) throw makeError('RECOVERY_NOT_CONFIGURED', 503);
  const digest = crypto.createHmac('sha256', key)
    .update(`recovery:${generation}:${id}:${normalized}`, 'utf8')
    .digest();
  let result = '';
  for (let index = 0; index < RECOVERY_CODE_LENGTH; index++) {
    result += PAIRING_ALPHABET[digest[index] % PAIRING_ALPHABET.length];
  }
  return result;
}

function safeHashEquals(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(String(left || '')) || !/^[a-f0-9]{64}$/i.test(String(right || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(String(left), 'hex'), Buffer.from(String(right), 'hex'));
}

function normalizeTimestamp(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeQueueCount(value) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.max(0, Math.min(100_000, number)) : 0;
}

function normalizeDeviceDiagnostics(value) {
  if (!value || typeof value !== 'object') return null;
  const queues = value.queues && typeof value.queues === 'object' ? value.queues : {};
  const dataOperations = normalizeQueueCount(queues.dataOperations);
  const stockOperations = normalizeQueueCount(queues.stockOperations);
  return {
    version: 1,
    reportedAt: normalizeTimestamp(value.reportedAt),
    appVersion: String(value.appVersion || 'unknown').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 30) || 'unknown',
    queues: {
      dataOperations,
      stockOperations,
      quarantinedStockOperations: normalizeQueueCount(queues.quarantinedStockOperations),
      totalOperations: dataOperations + stockOperations,
    },
  };
}

function normalizeDevice(value) {
  const id = normalizeClientId(value?.id);
  if (!id) return null;
  const createdAt = normalizeTimestamp(value.createdAt);
  const lastSeenAt = normalizeTimestamp(value.lastSeenAt, createdAt);
  const revokedAt = value.revokedAt === null || value.revokedAt === undefined
    ? null
    : normalizeTimestamp(value.revokedAt, null);
  return {
    id,
    name: normalizeDeviceName(value.name),
    source: ['pairing', 'recovery'].includes(value.source) ? value.source : 'legacy',
    createdAt,
    lastSeenAt,
    revokedAt,
    pairedBy: normalizeClientId(value.pairedBy),
    diagnostics: normalizeDeviceDiagnostics(value.diagnostics),
  };
}

function normalizeRecoveryState(value) {
  const currentHash = String(value?.currentHash || '').toLowerCase();
  const last = value?.lastRedemption && typeof value.lastRedemption === 'object'
    ? value.lastRedemption
    : null;
  return {
    version: 1,
    generation: Math.max(0, Math.trunc(normalizeTimestamp(value?.generation))),
    updatedAt: normalizeTimestamp(value?.updatedAt),
    currentHash: /^[a-f0-9]{64}$/.test(currentHash) ? currentHash : null,
    createdBy: normalizeClientId(value?.createdBy),
    lastRedemption: last && /^[a-f0-9]{64}$/i.test(String(last.previousHash || ''))
      ? {
          previousHash: String(last.previousHash).toLowerCase(),
          clientId: normalizeClientId(last.clientId),
          redeemedAt: normalizeTimestamp(last.redeemedAt),
          nextGeneration: Math.max(1, Math.trunc(normalizeTimestamp(last.nextGeneration, 1))),
        }
      : null,
  };
}

function normalizeRegistry(value) {
  const byId = new Map();
  const devices = Array.isArray(value?.devices) ? value.devices : [];
  for (const raw of devices) {
    const device = normalizeDevice(raw);
    if (!device) continue;
    const current = byId.get(device.id);
    if (!current || device.lastSeenAt >= current.lastSeenAt) byId.set(device.id, device);
  }
  return {
    version: 1,
    updatedAt: normalizeTimestamp(value?.updatedAt),
    devices: [...byId.values()],
  };
}

function normalizePairings(value, nowMs) {
  const items = Array.isArray(value?.items) ? value.items : [];
  const byHash = new Map();
  for (const item of items) {
    const hash = String(item?.hash || '').toLowerCase();
    const expiresAt = normalizeTimestamp(item?.expiresAt);
    if (!/^[a-f0-9]{64}$/.test(hash) || expiresAt <= nowMs) continue;
    byHash.set(hash, {
      hash,
      createdAt: normalizeTimestamp(item.createdAt),
      expiresAt,
      createdBy: normalizeClientId(item.createdBy),
    });
  }
  return {
    version: 1,
    updatedAt: normalizeTimestamp(value?.updatedAt),
    items: [...byHash.values()].slice(-20),
  };
}

function encodeJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8').toString('base64');
}

function decodeJson(payload, fallback) {
  try {
    if (typeof payload?.content !== 'string') return fallback;
    const text = Buffer.from(payload.content.replace(/\s+/g, ''), 'base64').toString('utf8');
    return JSON.parse(text);
  } catch {
    throw makeError('AUTH_DATA_INVALID', 503);
  }
}

function internalError(result, fallback = 'AUTH_STORAGE_FAILED') {
  if (result?.status === 409 || result?.status === 422) return makeError('AUTH_STORAGE_CONFLICT', 409);
  if (result?.status === 401 || result?.status === 403) return makeError('AUTH_STORAGE_DENIED', 503);
  return makeError(fallback, 503);
}

function publicDevice(device, currentClientId) {
  return {
    id: device.id,
    name: device.name,
    source: device.source,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
    current: device.id === currentClientId,
    diagnostics: device.diagnostics,
  };
}

function createDeviceAuthService({
  appClient,
  now = () => Date.now(),
  randomInt = crypto.randomInt,
  recoverySecret,
} = {}) {
  if (!appClient || typeof appClient.requestInternal !== 'function') {
    throw makeError('AUTH_STORAGE_UNAVAILABLE', 503);
  }

  let cachedRegistry = null;
  let cachedRegistryAt = 0;

  async function readJsonFile(path, fallback) {
    const result = await appClient.requestInternal({ method: 'GET', path });
    if (result.status === 404) return { exists: false, sha: null, value: fallback };
    if (!result.ok) throw internalError(result);
    const sha = String(result.payload?.sha || '');
    if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw makeError('AUTH_DATA_INVALID', 503);
    return { exists: true, sha, value: decodeJson(result.payload, fallback) };
  }

  async function writeJsonFile(path, value, sha, message) {
    const body = { message, content: encodeJson(value) };
    if (sha) body.sha = sha;
    return appClient.requestInternal({ method: 'PUT', path, body });
  }

  async function mutateJsonFile({ path, fallback, normalize, message, mutate }) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await readJsonFile(path, fallback);
      const normalized = normalize(current.value);
      const mutation = await mutate(normalized);
      const next = mutation?.next ?? mutation;
      const result = mutation?.result;
      const written = await writeJsonFile(path, next, current.sha, message);
      if (written.ok) return { value: next, result };
      if (written.status === 409 || written.status === 422) continue;
      throw internalError(written);
    }
    throw makeError('AUTH_STORAGE_CONFLICT', 409);
  }

  async function loadRegistry({ fresh = false } = {}) {
    const nowMs = now();
    if (!fresh && cachedRegistry && nowMs - cachedRegistryAt <= REGISTRY_CACHE_TTL_MS) {
      return cachedRegistry;
    }
    const current = await readJsonFile(DEVICE_REGISTRY_PATH, { version: 1, devices: [] });
    cachedRegistry = normalizeRegistry(current.value);
    cachedRegistryAt = nowMs;
    return cachedRegistry;
  }

  async function mutateRegistry(message, mutate) {
    const response = await mutateJsonFile({
      path: DEVICE_REGISTRY_PATH,
      fallback: { version: 1, devices: [] },
      normalize: normalizeRegistry,
      message,
      mutate: async registry => {
        const mutation = await mutate({
          version: 1,
          updatedAt: registry.updatedAt,
          devices: registry.devices.map(device => ({ ...device })),
        });
        const next = mutation?.next ?? mutation;
        next.version = 1;
        next.updatedAt = now();
        return { next: normalizeRegistry(next), result: mutation?.result };
      },
    });
    cachedRegistry = response.value;
    cachedRegistryAt = now();
    return response;
  }

  async function authorize(claims, deviceName) {
    const id = normalizeClientId(claims?.clientId);
    if (!id) throw makeError('SESSION_INVALID', 401);
    let registry = await loadRegistry();
    let device = registry.devices.find(item => item.id === id);

    if (!device) {
      registry = await loadRegistry({ fresh: true });
      device = registry.devices.find(item => item.id === id);
      if (!device) throw makeError('DEVICE_NOT_REGISTERED', 401);
    }
    if (device.revokedAt) throw makeError('DEVICE_REVOKED', 401);

    const nowMs = now();
    if (nowMs - device.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS || deviceName) {
      const response = await mutateRegistry('Update workshop device activity', current => {
        const found = current.devices.find(item => item.id === id);
        if (!found || found.revokedAt) throw makeError(found ? 'DEVICE_REVOKED' : 'DEVICE_NOT_REGISTERED', 401);
        found.lastSeenAt = nowMs;
        if (deviceName) found.name = normalizeDeviceName(deviceName, found.name);
        return { next: current, result: found };
      });
      device = response.result;
    }
    return device;
  }

  async function createPairing(claims, deviceName) {
    const current = await authorize(claims, deviceName);
    for (let attempt = 0; attempt < 5; attempt++) {
      const rawCode = createPairingCode(randomInt);
      const hash = hashPairingCode(rawCode);
      const createdAt = now();
      const expiresAt = createdAt + PAIRING_TTL_MS;
      let duplicate = false;
      await mutateJsonFile({
        path: PAIRINGS_PATH,
        fallback: { version: 1, items: [] },
        normalize: value => normalizePairings(value, createdAt),
        message: 'Create one-time device pairing code',
        mutate: pairings => {
          if (pairings.items.some(item => item.hash === hash)) {
            duplicate = true;
            return pairings;
          }
          pairings.items.push({ hash, createdAt, expiresAt, createdBy: current.id });
          pairings.updatedAt = createdAt;
          return pairings;
        },
      });
      if (duplicate) continue;
      return { code: formatPairingCode(rawCode), expiresAt, createdBy: current.id };
    }
    throw makeError('PAIRING_CODE_FAILED', 503);
  }

  async function redeemPairing({ code, clientId, deviceName }) {
    const id = normalizeClientId(clientId);
    const hash = hashPairingCode(code);
    if (!id) throw makeError('CLIENT_ID_INVALID', 400);
    if (!hash) throw makeError('PAIRING_CODE_INVALID', 400);
    const nowMs = now();
    const consumed = await mutateJsonFile({
      path: PAIRINGS_PATH,
      fallback: { version: 1, items: [] },
      normalize: value => {
        const items = Array.isArray(value?.items) ? value.items : [];
        return {
          version: 1,
          updatedAt: normalizeTimestamp(value?.updatedAt),
          items: items.filter(item => /^[a-f0-9]{64}$/i.test(String(item?.hash || ''))),
        };
      },
      message: 'Consume one-time device pairing code',
      mutate: pairings => {
        const item = pairings.items.find(entry => String(entry.hash).toLowerCase() === hash);
        if (!item) throw makeError('PAIRING_CODE_NOT_FOUND', 404);
        const expiresAt = normalizeTimestamp(item.expiresAt);
        pairings.items = pairings.items.filter(entry => String(entry.hash).toLowerCase() !== hash && normalizeTimestamp(entry.expiresAt) > nowMs);
        pairings.updatedAt = nowMs;
        return {
          next: pairings,
          result: {
            expired: expiresAt <= nowMs,
            createdBy: normalizeClientId(item.createdBy),
          },
        };
      },
    });
    if (consumed.result?.expired) throw makeError('PAIRING_CODE_EXPIRED', 410);

    const response = await mutateRegistry('Register paired workshop device', registry => {
      let device = registry.devices.find(item => item.id === id);
      if (!device) {
        device = {
          id,
          name: normalizeDeviceName(deviceName),
          source: 'pairing',
          createdAt: nowMs,
          lastSeenAt: nowMs,
          revokedAt: null,
          pairedBy: consumed.result?.createdBy || null,
        };
        registry.devices.push(device);
      } else {
        device.name = normalizeDeviceName(deviceName, device.name);
        device.source = 'pairing';
        device.lastSeenAt = nowMs;
        device.revokedAt = null;
        device.pairedBy = consumed.result?.createdBy || device.pairedBy || null;
      }
      return { next: registry, result: device };
    });
    return response.result;
  }

  async function rotateRecovery(claims, deviceName) {
    const current = await authorize(claims, deviceName);
    const code = createRecoveryCode(randomInt);
    const hash = hashRecoveryCode(code);
    const nowMs = now();
    const response = await mutateJsonFile({
      path: RECOVERY_STATE_PATH,
      fallback: { version: 1, generation: 0 },
      normalize: normalizeRecoveryState,
      message: 'Rotate workshop recovery code',
      mutate: state => ({
        next: {
          version: 1,
          generation: state.generation + 1,
          updatedAt: nowMs,
          currentHash: hash,
          createdBy: current.id,
          lastRedemption: null,
        },
        result: { code: formatRecoveryCode(code), generation: state.generation + 1 },
      }),
    });
    return response.result;
  }

  async function redeemRecovery({ code, clientId, deviceName }) {
    const id = normalizeClientId(clientId);
    const normalizedCode = normalizeRecoveryCode(code);
    const suppliedHash = hashRecoveryCode(normalizedCode);
    if (!id) throw makeError('CLIENT_ID_INVALID', 400);
    if (!suppliedHash) throw makeError('RECOVERY_CODE_INVALID', 400);
    const secret = Buffer.isBuffer(recoverySecret) ? recoverySecret : Buffer.from(String(recoverySecret || ''), 'utf8');
    if (secret.length < 32) throw makeError('RECOVERY_NOT_CONFIGURED', 503);
    const nowMs = now();

    const consumed = await mutateJsonFile({
      path: RECOVERY_STATE_PATH,
      fallback: { version: 1, generation: 0 },
      normalize: normalizeRecoveryState,
      message: 'Consume and rotate workshop recovery code',
      mutate: state => {
        let nextGeneration;
        let retry = false;
        if (safeHashEquals(state.currentHash, suppliedHash)) {
          nextGeneration = state.generation + 1;
        } else if (
          state.lastRedemption
          && safeHashEquals(state.lastRedemption.previousHash, suppliedHash)
          && state.lastRedemption.clientId === id
          && nowMs - state.lastRedemption.redeemedAt <= RECOVERY_RETRY_GRACE_MS
        ) {
          nextGeneration = state.lastRedemption.nextGeneration;
          retry = true;
        } else {
          throw makeError('RECOVERY_CODE_NOT_FOUND', 404);
        }

        const replacement = deriveReplacementRecoveryCode({
          code: normalizedCode,
          clientId: id,
          generation: nextGeneration,
          secret,
        });
        if (retry) {
          return {
            next: state,
            result: { code: formatRecoveryCode(replacement), generation: nextGeneration, retry: true },
          };
        }
        return {
          next: {
            version: 1,
            generation: nextGeneration,
            updatedAt: nowMs,
            currentHash: hashRecoveryCode(replacement),
            createdBy: id,
            lastRedemption: {
              previousHash: suppliedHash,
              clientId: id,
              redeemedAt: nowMs,
              nextGeneration,
            },
          },
          result: { code: formatRecoveryCode(replacement), generation: nextGeneration, retry: false },
        };
      },
    });

    const response = await mutateRegistry('Register recovered workshop device', registry => {
      let device = registry.devices.find(item => item.id === id);
      if (!device) {
        device = {
          id,
          name: normalizeDeviceName(deviceName),
          source: 'recovery',
          createdAt: nowMs,
          lastSeenAt: nowMs,
          revokedAt: null,
          pairedBy: null,
        };
        registry.devices.push(device);
      } else {
        device.name = normalizeDeviceName(deviceName, device.name);
        device.source = 'recovery';
        device.lastSeenAt = nowMs;
        device.revokedAt = null;
      }
      return { next: registry, result: device };
    });
    return { device: response.result, replacementCode: consumed.result.code };
  }

  async function listDevices(claims, deviceName) {
    const current = await authorize(claims, deviceName);
    const registry = await loadRegistry({ fresh: true });
    return registry.devices
      .map(device => publicDevice(device, current.id))
      .sort((left, right) => {
        if (!!left.revokedAt !== !!right.revokedAt) return left.revokedAt ? 1 : -1;
        if (left.current !== right.current) return left.current ? -1 : 1;
        return right.lastSeenAt - left.lastSeenAt;
      });
  }

  async function reportDiagnostics(claims, diagnostics, deviceName) {
    if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) {
      throw makeError('DEVICE_DIAGNOSTICS_INVALID', 400);
    }
    const current = await authorize(claims);
    const nowMs = now();
    const normalized = normalizeDeviceDiagnostics({
      ...diagnostics,
      reportedAt: nowMs,
    });
    if (!normalized) throw makeError('DEVICE_DIAGNOSTICS_INVALID', 400);
    const response = await mutateRegistry('Update workshop device diagnostics', registry => {
      const device = registry.devices.find(item => item.id === current.id);
      if (!device || device.revokedAt) throw makeError(device ? 'DEVICE_REVOKED' : 'DEVICE_NOT_REGISTERED', 401);
      device.lastSeenAt = nowMs;
      if (deviceName) device.name = normalizeDeviceName(deviceName, device.name);
      device.diagnostics = normalized;
      return { next: registry, result: device };
    });
    return publicDevice(response.result, current.id);
  }

  async function renameDevice(claims, targetClientId, deviceName) {
    await authorize(claims);
    const target = normalizeClientId(targetClientId || claims.clientId);
    if (!target) throw makeError('CLIENT_ID_INVALID', 400);
    const name = normalizeDeviceName(deviceName);
    const response = await mutateRegistry('Rename workshop device', registry => {
      const device = registry.devices.find(item => item.id === target);
      if (!device) throw makeError('DEVICE_NOT_FOUND', 404);
      device.name = name;
      return { next: registry, result: device };
    });
    return publicDevice(response.result, claims.clientId);
  }

  async function revokeDevice(claims, targetClientId) {
    const current = await authorize(claims);
    const target = normalizeClientId(targetClientId);
    if (!target) throw makeError('CLIENT_ID_INVALID', 400);
    if (target === current.id) throw makeError('DEVICE_SELF_REVOKE_DENIED', 400);
    const nowMs = now();
    const response = await mutateRegistry('Revoke workshop device', registry => {
      const device = registry.devices.find(item => item.id === target);
      if (!device) throw makeError('DEVICE_NOT_FOUND', 404);
      if (!device.revokedAt) device.revokedAt = nowMs;
      return { next: registry, result: device };
    });
    return publicDevice(response.result, current.id);
  }

  return {
    authorize,
    createPairing,
    listDevices,
    reportDiagnostics,
    redeemPairing,
    redeemRecovery,
    renameDevice,
    revokeDevice,
    rotateRecovery,
  };
}

module.exports = {
  DEVICE_REGISTRY_PATH,
  PAIRINGS_PATH,
  PAIRING_TTL_MS,
  RECOVERY_CODE_LENGTH,
  RECOVERY_STATE_PATH,
  createDeviceAuthService,
  createPairingCode,
  createRecoveryCode,
  deriveReplacementRecoveryCode,
  formatPairingCode,
  formatRecoveryCode,
  hashPairingCode,
  hashRecoveryCode,
  normalizeDeviceName,
  normalizeDeviceDiagnostics,
  normalizePairingCode,
  normalizeRecoveryCode,
};
