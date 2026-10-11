const webpack = require('webpack');
const { version } = require('../package.json');

// The app version shown on the About page comes from the root package.json
// at build (and test) time, so it never has to be updated by hand.
process.env.REACT_APP_VERSION = version;

const override = config => {
  config.resolve = config.resolve || {};
  config.resolve.fallback = {
    ...(config.resolve.fallback || {}),
    assert: require.resolve('assert/'),
    buffer: require.resolve('buffer/'),
    process: require.resolve('process/browser.js'),
    stream: false,
    util: false
  };

  config.plugins = (config.plugins || []).concat([
    new webpack.ProvidePlugin({
      process: 'process/browser.js',
      Buffer: ['buffer', 'Buffer']
    })
  ]);

  return config;
};

// react-scripts 5 writes a webpack-dev-server 4 config. The dev server is
// overridden to v5 for security fixes, so map the removed v4 hooks onto v5.
const devServer = configFunction => (proxy, allowedHost) => {
  const {
    onBeforeSetupMiddleware: before,
    onAfterSetupMiddleware: after,
    https,
    ...config
  } = configFunction(proxy, allowedHost);

  if (https) {
    config.server = typeof https === 'object' ? { type: 'https', options: https } : 'https';
  }

  config.setupMiddlewares = (middlewares, server) => {
    if (before) before(server);
    if (after) after(server);
    return middlewares;
  };

  return config;
};

module.exports = { webpack: override, devServer };
