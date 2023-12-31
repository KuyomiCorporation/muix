const fse = require('fs-extra');
const lodash = require('lodash');
const path = require('path');
const { promisify } = require('util');
const webpackCallbackBased = require('webpack');
const yargs = require('yargs');
const createWebpackConfig = require('./webpack.config');

const webpack = promisify(webpackCallbackBased);

const workspaceRoot = path.join(__dirname, '../../');
const snapshotDestPath = path.join(workspaceRoot, 'size-snapshot.json');

/**
 * creates size snapshot for every bundle that built with webpack
 */
async function getWebpackSizes(webpackEnvironment) {
  await fse.mkdirp(path.join(__dirname, 'build'));

  const configurations = await createWebpackConfig(webpack, webpackEnvironment);
  const webpackMultiStats = await webpack(configurations);

  const sizes = [];
  webpackMultiStats.stats.forEach((webpackStats) => {
    if (webpackStats.hasErrors()) {
      const { entrypoints, errors } = webpackStats.toJson({
        all: false,
        entrypoints: true,
        errors: true,
      });
      throw new Error(
        `The following errors occurred during bundling of ${Object.keys(
          entrypoints,
        )} with webpack: \n${errors.join('\n')}`,
      );
    }

    const stats = webpackStats.toJson({ all: false, assets: true });
    const assets = new Map(stats.assets.map((asset) => [asset.name, asset]));

    Object.entries(stats.assetsByChunkName).forEach(([chunkName, assetName]) => {
      const parsedSize = assets.get(assetName).size;
      const gzipSize = assets.get(`${assetName}.gz`).size;
      sizes.push([chunkName, { parsed: parsedSize, gzip: gzipSize }]);
    });
  });

  return sizes;
}

// waiting for String.prototype.matchAll in node 10
function* matchAll(string, regex) {
  let match = null;
  do {
    match = regex.exec(string);
    if (match !== null) {
      yield match;
    }
  } while (match !== null);
}

/**
 * Inverse to `pretty-bytes`
 * @param {string} n
 * @param {'B', 'kB' | 'MB' | 'GB' | 'TB' | 'PB'} unit
 * @returns {number}
 */

function prettyBytesInverse(n, unit) {
  const metrixPrefix = unit.length < 2 ? '' : unit[0];
  const metricPrefixes = ['', 'k', 'M', 'G', 'T', 'P'];
  const metrixPrefixIndex = metricPrefixes.indexOf(metrixPrefix);
  if (metrixPrefixIndex === -1) {
    throw new TypeError(
      `unrecognized metric prefix '${metrixPrefix}' in unit '${unit}'. only '${metricPrefixes.join(
        "', '",
      )}' are allowed`,
    );
  }

  const power = metrixPrefixIndex * 3;
  return n * 10 ** power;
}

/**
 * parses output from next build to size snapshot format
 * @returns {[string, { gzip: number, files: number, packages: number }][]}
 */

async function getNextPagesSize() {
  const consoleOutput = await fse.readFile(path.join(__dirname, 'build/docs.next'), {
    encoding: 'utf8',
  });
  const pageRegex =
    /(?<treeViewPresentation>┌|├|└)\s+((?<fileType>λ|○|●)\s+)?(?<pageUrl>[^\s]+)\s+(?<sizeFormatted>[0-9.]+)\s+(?<sizeUnit>\w+)/gm;

  const sharedChunks = [];

  const entries = Array.from(matchAll(consoleOutput, pageRegex), (match) => {
    const { pageUrl, sizeFormatted, sizeUnit } = match.groups;

    let snapshotId = `docs:${pageUrl}`;
    // used to be tracked with custom logic hence the different ids
    if (pageUrl === '/') {
      snapshotId = 'docs.landing';
      // chunks contain a content hash that makes the names
      // unsuitable for tracking. Using stable name instead:
    } else if (/^chunks\/pages\/_app\.(.+)\.js$/.test(pageUrl)) {
      snapshotId = 'docs.main';
    } else if (/^chunks\/main\.(.+)\.js$/.test(pageUrl)) {
      snapshotId = 'docs:shared:runtime/main';
    } else if (/^chunks\/webpack\.(.+)\.js$/.test(pageUrl)) {
      snapshotId = 'docs:shared:runtime/webpack';
    } else if (/^chunks\/commons\.(.+)\.js$/.test(pageUrl)) {
      snapshotId = 'docs:shared:chunk/commons';
    } else if (/^chunks\/framework\.(.+)\.js$/.test(pageUrl)) {
      snapshotId = 'docs:shared:chunk/framework';
    } else if (/^chunks\/(.*)\.js$/.test(pageUrl)) {
      // shared chunks are unnamed and only have a hash
      // we just track their tally and summed size
      sharedChunks.push(prettyBytesInverse(sizeFormatted, sizeUnit));
      // and not each chunk individually
      return null;
    }

    return [
      snapshotId,
      {
        parsed: prettyBytesInverse(sizeFormatted, sizeUnit),
        gzip: -1,
      },
    ];
  }).filter((entry) => entry !== null);

  entries.push([
    'docs:chunk:shared',
    {
      parsed: sharedChunks.reduce((sum, size) => sum + size, 0),
      gzip: -1,
      tally: sharedChunks.length,
    },
  ]);

  return entries;
}

async function run(argv) {
  const { analyze, accurateBundles } = argv;

  const bundleSizes = lodash.fromPairs([
    ...(await getWebpackSizes({ analyze, accurateBundles })),
    ...(await getNextPagesSize()),
  ]);

  await fse.writeJSON(snapshotDestPath, bundleSizes, { spaces: 2 });
}

yargs
  .command({
    command: '$0',
    description: 'Saves a size snapshot in size-snapshot.json',
    builder: (command) => {
      return command
        .option('analyze', {
          default: false,
          describe: 'Creates a webpack-bundle-analyzer report for each bundle.',
          type: 'boolean',
        })
        .option('accurateBundles', {
          default: false,
          describe: 'Displays used bundles accurately at the cost of CPU cycles.',
          type: 'boolean',
        });
    },
    handler: run,
  })
  .help()
  .strict(true)
  .version(false)
  .parse();
