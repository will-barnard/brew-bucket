function notFound(_req, _res, next) {
  next(Object.assign(new Error('not found'), { status: 404 }));
}

function handler(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', req.method, req.originalUrl, err.stack || err.message);
  if (res.headersSent) return res.destroy();
  res.status(status).json({ error: err.message || 'internal error' });
}

module.exports = { notFound, handler };
