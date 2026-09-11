const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
module.exports = {
  port: num(process.env.PORT, 8477),
  dataDir: process.env.DATA_DIR || '/data',
  // Presented by the control plane on every internal request.
  secret: process.env.NODE_SHARED_SECRET || '',
  // Verifies presigned direct-transfer tokens. Must match the control plane's
  // DIRECT_URL_SECRET, or direct transfers fail closed.
  directSecret: process.env.DIRECT_URL_SECRET || process.env.NODE_SHARED_SECRET || '',
  directEnabled: /^(1|true|yes|on)$/i.test(process.env.DIRECT_ENABLED || 'true'),
  version: require('../package.json').version,
};
