const webpack = require('webpack');
const { version } = require('../package.json');

// The app version shown on the About page comes from the root package.json
// at build (and test) time, so it never has to be updated by hand.
process.env.REACT_APP_VERSION = version;

module.exports = function override(config) {
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
