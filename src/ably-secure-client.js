import {
  SECURE_ABLY_AUTH_ENDPOINT,
  requestSessionAuthorizedAblyToken,
} from "./ably-session-auth.js";

const DEFAULT_RETRY_OPTIONS = Object.freeze({
  disconnectedRetryTimeout: 2_000,
  suspendedRetryTimeout: 5_000,
  realtimeRequestTimeout: 15_000,
  idlePeriod: 5_000,
  heartbeatInterval: 5_000,
});

function makeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function createSecureAblyAuthCallback({
  clientId,
  endpoint = SECURE_ABLY_AUTH_ENDPOINT,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
} = {}) {
  if (typeof clientId !== "string" || clientId.length < 8) {
    throw makeError("CLIENT_ID_INVALID");
  }

  return (_tokenParams, callback) => {
    if (typeof callback !== "function") return;

    requestSessionAuthorizedAblyToken({
      clientId,
      endpoint,
      fetchImpl,
      storage,
    }).then(
      details => callback(null, details.token),
      error => callback(error),
    );
  };
}

export function createSecureAblyRealtimeOptions({
  clientId,
  endpoint = SECURE_ABLY_AUTH_ENDPOINT,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  autoConnect = true,
} = {}) {
  return {
    clientId,
    autoConnect: autoConnect === true,
    authCallback: createSecureAblyAuthCallback({
      clientId,
      endpoint,
      fetchImpl,
      storage,
    }),
    ...DEFAULT_RETRY_OPTIONS,
  };
}
