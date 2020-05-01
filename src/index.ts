/// <reference types="./typings/fibers" />
/// <reference types="./typings/less" />
/// <reference types="./typings/postcss-modules" />
/// <reference types="./typings/sass" />
/// <reference types="./typings/stylus" />

import { createFilter } from "@rollup/pluginutils";

import path from "path";
import Concat from "concat-with-sourcemaps";
import { Plugin, OutputChunk } from "rollup";
import postcss from "postcss";
import cssnano from "cssnano";

import { ExtractedData, LoaderContext, Options, Payload, PostCSSLoaderOptions } from "./types";
import Loaders from "./loaders";
import { humanlizePath, relativePath, normalizePath } from "./utils/path";
import { mm } from "./utils/sourcemap";
import {
  inferOption,
  inferResolverOption,
  ensurePCSSOption,
  ensurePCSSPlugins,
  ensureUseOption,
  inferModeOption,
} from "./utils/options";
import { getIds } from "./utils/chunk";

export default (options: Options = {}): Plugin => {
  const filter = createFilter(options.include, options.exclude);

  const postcssLoaderOpts: PostCSSLoaderOptions = {
    ...inferModeOption(options.mode),

    minimize: inferOption(options.minimize, false),
    config: inferOption(options.config, {}),
    import: inferResolverOption(options.import, options.alias),
    url: inferResolverOption(options.url, options.alias),
    modules: inferOption(options.modules, false),

    namedExports: options.namedExports ?? false,
    autoModules: options.autoModules ?? false,
    extensions: options.extensions ?? [".css", ".sss", ".pcss", ".postcss"],

    postcss: {
      parser: ensurePCSSOption(options.parser),
      syntax: ensurePCSSOption(options.syntax),
      stringifier: ensurePCSSOption(options.stringifier),
      plugins: ensurePCSSPlugins(options.plugins),
    },
  };

  const loaders = new Loaders({
    use: [["postcss", postcssLoaderOpts], "sourcemap", ...ensureUseOption(options.use, options)],
    loaders: options.loaders ?? [],
    extensions: postcssLoaderOpts.extensions,
  });

  const isSupported = (id: string): boolean => filter(id) && loaders.isSupported(id);

  const extracted = new Map<string, NonNullable<Payload["extracted"]>>();

  const plugin: Plugin = {
    name: "styles",

    async transform(code, id) {
      if (!isSupported(id)) return;

      // Check if file was already processed into JS
      // by other instance(s) of this or other plugin(s)
      try {
        this.parse(code, undefined); // If it doesn't throw...
        this.warn(`Skipping processed file ${humanlizePath(id)}`);
        return;
      } catch {
        // Was not already processed, continuing
      }

      if (typeof options.onImport === "function") options.onImport(code, id);

      const ctx: LoaderContext = {
        id,
        sourceMap: options.sourceMap,
        deps: new Set(),
        assets: new Map<string, Uint8Array>(),
        warn: this.warn.bind(this),
        error: this.error.bind(this),
        plugin: this,
        options: {},
      };

      const res = await loaders.process({ code }, ctx);

      for (const dep of ctx.deps) this.addWatchFile(dep);

      for (const [fileName, source] of ctx.assets)
        this.emitFile({ type: "asset", source, fileName });

      if (postcssLoaderOpts.extract) {
        res.extracted && extracted.set(id, res.extracted);
        return {
          code: res.code,
          map: { mappings: "" as const },
        };
      }

      return {
        code: res.code,
        map: (options.sourceMap ? res.map : undefined) ?? { mappings: "" as const },
      };
    },

    augmentChunkHash(chunk) {
      if (extracted.size === 0) return;

      const infoFn = this.getModuleInfo.bind(this);
      const chunkIds = getIds(chunk, infoFn).filter(isSupported);

      if (chunkIds.length === 0) return;

      const moduleIds = [...this.moduleIds];

      const hashable = [...extracted.values()]
        .filter(e => chunkIds.includes(e.id))
        .sort((a, b) => moduleIds.indexOf(a.id) - moduleIds.indexOf(b.id))
        .map(e => ({
          name: chunk.name,
          ...e,
          id: humanlizePath(e.id),
          map: mm(e.map).relative().toString(),
        }));

      if (hashable.length === 0) return;

      return JSON.stringify(hashable);
    },

    async generateBundle(opts, bundle) {
      if (extracted.size === 0 || !(opts.dir || opts.file)) return;

      const infoFn = this.getModuleInfo.bind(this);
      const moduleIds = [...this.moduleIds];

      const dir = opts.dir ?? path.dirname(opts.file ?? "");

      const getExtractedData = (file: string, ids: string[]): ExtractedData => {
        const fileName =
          typeof postcssLoaderOpts.extract === "string"
            ? relativePath(dir, path.resolve(postcssLoaderOpts.extract))
            : normalizePath(path.dirname(file), `${path.basename(file, path.extname(file))}.css`);

        const fileBaseName = path.basename(fileName);
        const fileDir = path.dirname(path.resolve(dir, fileName));

        const entries = [...extracted.values()]
          .filter(e => ids.includes(e.id))
          .sort((a, b) => moduleIds.indexOf(a.id) - moduleIds.indexOf(b.id));

        const concat = new Concat(true, fileBaseName, "\n");
        for (const res of entries) {
          const relative = relativePath(dir, res.id);
          const map = mm(res.map).relative(fileDir).toObject();
          type ConcatSourceMap = Exclude<Parameters<typeof concat.add>[2], string | undefined>;
          concat.add(relative, res.css, (map as unknown) as ConcatSourceMap);
        }

        let css = concat.content.toString();
        const map = mm(concat.sourceMap);

        if (options.sourceMap === "inline") {
          css += map.toCommentData();
        } else if (options.sourceMap === true) {
          css += map.toCommentFile(fileBaseName);
        }

        return {
          css,
          map: options.sourceMap === true ? map.toString() : undefined,
          cssFileName: fileName,
          mapFileName: `${fileName}.map`,
        };
      };

      const getEmitted = (): Map<string, string[]> => {
        const chunks = Object.values(bundle).filter((c): c is OutputChunk => c.type === "chunk");

        const entryIndex = chunks.findIndex(v => v.isEntry);
        const [entry] = chunks.splice(entryIndex, 1);

        const idsMap = new Map<string, string[]>();
        const ids: string[] = [];

        if (typeof postcssLoaderOpts.extract !== "string") {
          for (const chunk of chunks) {
            const chunkIds = getIds(chunk, infoFn)
              .filter(isSupported)
              .sort((a, b) => moduleIds.indexOf(a) - moduleIds.indexOf(b));

            if (chunkIds.length === 0) continue;

            ids.push(...chunkIds);
            idsMap.set(chunk.fileName, chunkIds);
          }
        }

        const entryIds = moduleIds.filter(id => !ids.includes(id) && isSupported(id));
        if (entryIds.length > 0) idsMap.set(entry.fileName, entryIds);

        return idsMap;
      };

      for await (const [file, ids] of getEmitted()) {
        const res = getExtractedData(file, ids);

        if (options.onExtract) {
          const shouldExtract = options.onExtract(getExtractedData);
          if (!shouldExtract) continue;
        }

        // Perform cssnano on the extracted file
        if (postcssLoaderOpts.minimize) {
          const cssNanoOpts: cssnano.CssNanoOptions & postcss.ProcessOptions =
            typeof postcssLoaderOpts.minimize === "object" ? postcssLoaderOpts.minimize : {};

          cssNanoOpts.from = res.cssFileName;
          if (options.sourceMap === "inline") {
            cssNanoOpts.map = { inline: true };
          } else if (options.sourceMap === true) {
            cssNanoOpts.map = { prev: res.map };
            cssNanoOpts.to = res.cssFileName;
          }

          const resMin = await cssnano.process(res.css, cssNanoOpts);
          res.css = resMin.css;
          if (options.sourceMap === true) res.map = resMin.map?.toString();
        }

        this.emitFile({
          type: "asset",
          source: res.css,
          fileName: res.cssFileName,
        });

        if (res.map) {
          this.emitFile({
            type: "asset",
            source: res.map,
            fileName: res.mapFileName,
          });
        }
      }
    },
  };

  return plugin;
};
