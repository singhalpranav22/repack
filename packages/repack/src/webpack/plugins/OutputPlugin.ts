import path from 'path';
import webpack from 'webpack';
import { CLI_OPTIONS_ENV_KEY } from '../../env';
import { CliOptions, Rule, WebpackPlugin } from '../../types';
import { AssetsCopyProcessor } from './utils/AssetsCopyProcessor';

/**
 * {@link OutputPlugin} configuration options.
 */
export interface OutputPluginConfig {
  /** Target application platform. */
  platform: string;
  /** Whether the development server is enabled and running. */
  devServerEnabled?: boolean;
  /**
   * Mark all chunks as a local chunk, meaning they will be bundled into the `.ipa`/`.apk` file.
   * All chunks not matched by the rule(s) will become a remote one.
   */
  localChunks?: Rule | Rule[];
  /**
   * Output directory for all remote chunks and assets that are not bundled into
   * the `.ipa`/`.apk` file.
   * When left unspecified (`undefined`), the files will be available under `output.path`, next to
   * the main/index bundle and other local chunks.
   */
  remoteChunksOutput?: string;
  /**
   * The entry chunk name, 'main' by default.
   */
  entry?: string;
}

/**
 * Plugin for copying generated files (bundle, chunks, assets) from Webpack's built location to the
 * React Native application directory, so that the files can be packed together into the `ipa`/`apk`.
 *
 * @category Webpack Plugin
 */
export class OutputPlugin implements WebpackPlugin {
  /**
   * Constructs new `OutputPlugin`.
   *
   * @param config Plugin configuration options.
   */
  constructor(private config: OutputPluginConfig) {
    if (!this.config.platform) {
      throw new Error('Missing `platform` option in `OutputPlugin`');
    }
  }

  /**
   * Apply the plugin.
   *
   * @param compiler Webpack compiler instance.
   */
  apply(compiler: webpack.Compiler) {
    const cliOptions: CliOptions | null = JSON.parse(
      process.env[CLI_OPTIONS_ENV_KEY] ?? 'null'
    );

    // Noop when running from Webpack CLI or when running with dev server
    if (
      !cliOptions ||
      'start' in cliOptions.arguments ||
      this.config.devServerEnabled
    ) {
      return;
    }

    const logger = compiler.getInfrastructureLogger('ReactNativeOutputPlugin');

    const args = cliOptions.arguments.bundle;
    let { bundleOutput, assetsDest = '', sourcemapOutput = '' } = args;
    if (!path.isAbsolute(bundleOutput)) {
      bundleOutput = path.join(cliOptions.config.root, bundleOutput);
    }
    const bundleOutputDir = path.dirname(bundleOutput);

    if (!sourcemapOutput) {
      sourcemapOutput = `${bundleOutput}.map`;
    }
    if (!path.isAbsolute(sourcemapOutput)) {
      sourcemapOutput = path.join(cliOptions.config.root, sourcemapOutput);
    }

    if (!assetsDest) {
      assetsDest = bundleOutputDir;
    }

    let remoteChunksOutput = this.config.remoteChunksOutput;
    if (remoteChunksOutput && !path.isAbsolute(remoteChunksOutput)) {
      remoteChunksOutput = path.join(
        cliOptions.config.root,
        remoteChunksOutput
      );
    }

    logger.debug('Detected output paths:', {
      bundleOutput,
      sourcemapOutput,
      assetsDest,
      remoteChunksOutput,
    });

    const isLocalChunk = (chunkId: string): boolean =>
      webpack.ModuleFilenameHelpers.matchObject(
        {
          include: this.config.localChunks ?? [],
        },
        chunkId
      );

    let entryGroup: webpack.Compilation['chunkGroups'][0] | undefined;
    let entryChunk: webpack.Chunk | undefined;
    const entryChunkName = this.config.entry ?? 'main';
    const localChunks: webpack.Chunk[] = [];
    const remoteChunks: webpack.Chunk[] = [];

    compiler.hooks.compilation.tap('OutputPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'OutputPlugin',
          stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONS,
        },
        () => {
          entryGroup = compilation.chunkGroups.find((group) =>
            group.isInitial()
          );
          entryChunk = entryGroup?.chunks.find(
            (chunk) => chunk.name === entryChunkName
          );
          const sharedChunks = new Set<webpack.Chunk>();

          for (const chunk of compilation.chunks) {
            // Do not process shared chunks right now.
            if (sharedChunks.has(chunk)) {
              continue;
            }

            [...chunk.getAllInitialChunks()]
              .filter((sharedChunk) => sharedChunk !== chunk)
              .forEach((sharedChunk) => {
                sharedChunks.add(sharedChunk);
              });

            // Entry chunk
            if (entryChunk && entryChunk === chunk) {
              localChunks.push(chunk);
            } else if (isLocalChunk(chunk.name ?? chunk.id?.toString())) {
              localChunks.push(chunk);
            } else {
              remoteChunks.push(chunk);
            }
          }

          // Process shared chunks to add them either as local or remote chunk.
          for (const sharedChunk of sharedChunks) {
            const isUsedByLocalChunk = localChunks.some((localChunk) => {
              return [...localChunk.getAllInitialChunks()].includes(
                sharedChunk
              );
            });
            if (
              isUsedByLocalChunk ||
              isLocalChunk(sharedChunk.name ?? sharedChunk.id?.toString())
            ) {
              localChunks.push(sharedChunk);
            } else {
              remoteChunks.push(sharedChunk);
            }
          }

          if (!entryChunk) {
            throw new Error(
              'Cannot infer entry chunk - this should have not happened.'
            );
          }

          const mainBundleAssetName = [...entryChunk.files][0];
          compilation.updateAsset(
            mainBundleAssetName,
            (source) =>
              new webpack.sources.ConcatSource(
                `var __CHUNKS__=${JSON.stringify({
                  local: localChunks.map(
                    (localChunk) => localChunk.name ?? localChunk.id?.toString()
                  ),
                })};`,
                '\n',
                source
              )
          );
        }
      );
    });

    compiler.hooks.afterEmit.tapPromise('OutputPlugin', async (compilation) => {
      const outputPath = compilation.outputOptions.path;
      if (!outputPath) {
        throw new Error('Cannot infer output path from compilation');
      }

      const localAssetsCopyProcessor = new AssetsCopyProcessor({
        platform: this.config.platform,
        compilation,
        outputPath,
        bundleOutput,
        bundleOutputDir,
        sourcemapOutput,
        assetsDest,
        logger,
      });
      const remoteAssetsCopyProcessor = new AssetsCopyProcessor({
        platform: this.config.platform,
        compilation,
        outputPath,
        bundleOutput: '',
        bundleOutputDir: remoteChunksOutput ?? '',
        sourcemapOutput: '',
        assetsDest: remoteChunksOutput ?? '',
        logger,
      });

      for (const chunk of localChunks) {
        // Process entry chunk
        localAssetsCopyProcessor.enqueueChunk(chunk, {
          isEntry: entryChunk === chunk,
        });
      }

      if (remoteChunksOutput) {
        for (const chunk of remoteChunks) {
          remoteAssetsCopyProcessor.enqueueChunk(chunk, { isEntry: false });
        }
      }

      await Promise.all([
        ...localAssetsCopyProcessor.execute(),
        ...remoteAssetsCopyProcessor.execute(),
      ]);
    });
  }
}
