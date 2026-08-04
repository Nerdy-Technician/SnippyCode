const proxy = require('http-proxy-middleware');

module.exports = function setupProxy(app) {
  app.use(
    '/api',
    proxy({
      target: 'http://localhost:5000',
      changeOrigin: true
    })
  );
  app.use(
    '/raw',
    proxy({
      target: 'http://localhost:5000',
      changeOrigin: true
    })
  );
};
