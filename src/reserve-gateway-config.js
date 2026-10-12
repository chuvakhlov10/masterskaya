// Public addresses only. Keep automatic failover disabled until the reserve
// passes authenticated health and repository-read checks with a paired device.
export default {
  storage: 'https://masterskaya-six.vercel.app/api/storage',
  ably: 'https://masterskaya-six.vercel.app/api/ably',
  enabled: false,
};
