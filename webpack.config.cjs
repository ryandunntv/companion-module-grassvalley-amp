const path = require('path');

module.exports = {
  target: 'node',               // for Node.js environment (Companion)
  mode: 'production',           // optimized build
  entry: './index.js',          // your module's main file
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js',
    libraryTarget: 'commonjs2', // compatible with Node module exports
  },
  resolve: {
    extensions: ['.js'],
  },
  externals: {},                // bundles all dependencies
};
