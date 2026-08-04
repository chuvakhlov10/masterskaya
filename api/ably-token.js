'use strict';

const Ably = require('ably');
const { createHandler } = require('./ably-token-core.cjs');

module.exports = createHandler({
  createAblyRest: (key) => new Ably.Rest({ key }),
});
