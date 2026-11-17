'use strict';

const { gzipSync } = require('node:zlib');

// The invocation limit includes JSON escaping of the entire HTTP envelope.
// Compress before base64 encoding that envelope; browsers decode HTTP gzip.
function compressResponse(response) {
  if (response.isBase64Encoded || response.statusCode !== 200 ||
      typeof response.body !== 'string' || Buffer.byteLength(response.body) < 128 * 1024) return response;
  const body = gzipSync(response.body).toString('base64');
  if (body.length >= Buffer.byteLength(response.body)) return response;
  return {
    ...response,
    headers: { ...response.headers, 'Content-Encoding': 'gzip' },
    isBase64Encoded: true,
    body,
  };
}

module.exports = { compressResponse };
