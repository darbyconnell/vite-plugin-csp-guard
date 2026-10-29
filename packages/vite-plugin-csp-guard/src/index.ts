import {
  Plugin,
  Rolldown,
  ViteDevServer,
  type ResolvedConfig,
} from "vite";
import {
  CSPPluginContext,
  MyPluginOptions,
  TransformationStatus,
} from "./types";
import { DEFAULT_DEV_POLICY, DEFAULT_POLICY } from "./policy/constants";
import {
  calculateSkip,
  createNewCollection,
  overrideChecker,
  generateHash,
} from "./policy/core";
import {
  applyPendingTransformPolicy,
  transformHandler,
  transformIndexHtmlHandler,
} from "./transform";
import {
  cssFilter,
  jsFilter,
  parseOutliers,
  preCssFilter,
  tsFilter,
} from "./utils";
import { unstable_handleModuleParsed } from "./css";
import { FEATURE_FLAGS } from "./constants";
import { mergePolicies } from "csp-toolkit";
import {
  buildIntegrityMappings,
  analyzeDynamicImports,
  processHtmlForSri,
  installSriRuntime,
  withBasePathname,
  collectReachableFiles,
} from "./sri";
import { injectRuntimeAndShiftSourceMaps } from "./sri/injectRuntime";
import type { OutputBundle as RollupOutputBundle, OutputChunk } from "rollup";

export default function vitePluginCSP(
  options: MyPluginOptions | undefined = {},
): Plugin {
  const {
    algorithm = "sha256",
    policy,
    dev = {},
    features = FEATURE_FLAGS,
    build = {},
    override = false,
    debug = false,
    transformPolicy,
  } = options;

  let pluginContext: Rolldown.PluginContext | undefined = undefined; //Needed for logging
  let isDevMode = false; // This is a flag to check if we are in dev mode
  let server: ViteDevServer | undefined = undefined;
  let viteVersion: string | undefined = undefined;
  let resolvedConfig: ResolvedConfig | undefined = undefined;

  const { outlierSupport = [], run = false, override: devOverride } = dev;
  const {
    sri = false,
    override: buildOverride,
  } = build;

  // Normalize SRI configuration (sri can be boolean or SriOptions object)
  const sriEnabled = typeof sri === "boolean" ? sri : !!sri;
  const isSriObject = typeof sri === "object" && sri !== null;
  const sriConfig = {
    enabled: sriEnabled,
    runtimePatchDynamicLinks: isSriObject
      ? (sri.runtimePatchDynamicLinks ?? true)
      : true,
    preloadDynamicChunks: isSriObject
      ? (sri.preloadDynamicChunks ?? true)
      : true,
    skipResources: isSriObject ? (sri.skipResources ?? []) : [],
    crossorigin: isSriObject ? sri.crossorigin : undefined,
  };

  const sriRuntimeOptions = `{crossorigin:${
    sriConfig.crossorigin ? JSON.stringify(sriConfig.crossorigin) : "undefined"
  },skipResources:${JSON.stringify(sriConfig.skipResources)}}`;
  const sriRuntimeFingerprint =
    `${installSriRuntime.toString()}|${sriRuntimeOptions}|${algorithm}`;
  // Bump whenever the injected wrapper around the SRI runtime changes.
  const SRI_INJECTION_VERSION = "2";

  const CORE_COLLECTION = createNewCollection();

  const overrideIsFine = overrideChecker({
    userPolicy: policy,
    override,
  });
  if (!overrideIsFine) {
    throw new Error(
      "Override cannot be true when a csp policy is not provided",
    );
  }
  const isUserDevOpt = run; // This is a flag to check if the user wants to run in dev mode
  const isDevAndAllowed = () => isDevMode && isUserDevOpt; // This is a function to check if we can run in dev mode

  const transformationStatus: TransformationStatus = new Map<string, boolean>();
  const isTransformationStatusEmpty = () => transformationStatus.size === 0;

  // Chunk hashes added to the CSP before Vite fills the preload lists. The post
  // generateBundle hook swaps them for hashes of the final chunk code.
  const provisionalChunkHashes = new Map<string, string>();

  // CSS and assets of the chunk each module ended up in. Recorded in
  // augmentChunkHash because Vite deletes CSS-only chunks before the post
  // generateBundle hook runs.
  const filesByModuleId = new Map<string, string[]>();

  const requirements = parseOutliers(outlierSupport);
  const shouldSkip = calculateSkip(policy);

  // Create the shared plugin context
  const cspContext: CSPPluginContext = {
    options: {
      algorithm,
      policy,
      dev,
      features,
      build,
      override,
      debug,
      transformPolicy,
    },
    algorithm,
    collection: CORE_COLLECTION,
    policy: policy || {},
    requirements,
    debug,
    isDevMode,
    viteVersion,
    shouldSkip,
  };

  return {
    name: "vite-plugin-csp-guard",
    enforce: "post",
    buildStart() {
      pluginContext = this;
      // Watch-mode rebuilds reuse this instance; drop hashes from the previous build.
      provisionalChunkHashes.clear();
      for (const hashes of Object.values(CORE_COLLECTION)) hashes.clear();
      filesByModuleId.clear();
      viteVersion = this.meta.viteVersion;
      if (!viteVersion) {
        throw new Error(
          "Please ensure you're using a minimum version of vite 8.0.0.",
        );
      }
    },
    apply(config, { command }) {
      // If we are in dev mode return true
      if (command === "serve" && config.mode === "development" && isUserDevOpt)
        return true;
      // apply only on build but not for SSR
      if (command === "build" && !config.build?.ssr) {
        return true;
      }
      if (command === "build" && features.mpa && config.build?.ssr) {
        return true;
      }
      return false;
    },
    configResolved(config) {
      resolvedConfig = config;
      const devCommand =
        config.command === "serve" && config.mode === "development";

      if (devCommand && !isUserDevOpt) {
        console.warn(
          "You are running in development mode but dev.run is set to false. This will not inject the default policy for development mode",
        );
      }

      if (devCommand) {
        isDevMode = true;
      }
      if (config.appType !== "spa" && !features.mpa) {
        throw new Error("Vite CSP Plugin only works with SPA apps for now");
      }
      if (config.build.ssr && !features.mpa) {
        throw new Error("Vite CSP Plugin does not work with SSR apps");
      }

      cspContext.isDevMode = isDevMode;
    },
    load(id) {
      if (!isDevAndAllowed()) return null; // Exit early if we are not in dev mode or if we are in dev mode but the user does not want to run in dev mode

      // Entry points to files that need to be transformed
      const isCss = cssFilter(id);
      const isPreCss = preCssFilter(id);
      const isJs = jsFilter(id);
      const isTs = tsFilter(id);
      if (isCss || isJs || isTs || isPreCss)
        transformationStatus.set(id, false);

      return null;
    },
    transform: {
      order: requirements.postTransform ? "post" : "pre",
      handler: async (code, id) => {
        if (features.mpa) {
          // console.log(id);
        }

        if (!isDevAndAllowed()) return null; // Exit early if we are not in dev mode or if we are in dev mode but the user does not want to run in dev mode

        await transformHandler({
          code,
          id,
          cspContext,
          transformationStatus,
          server,
          transformMode: requirements.postTransform ? "post" : "pre",
        });
        return null;
      },
    },
    augmentChunkHash(chunk) {
      const { viteMetadata } = chunk;
      if (
        sriConfig.enabled &&
        sriConfig.runtimePatchDynamicLinks &&
        viteMetadata
      ) {
        const files = [
          ...viteMetadata.importedCss,
          ...viteMetadata.importedAssets,
        ];
        for (const moduleId of chunk.moduleIds) {
          filesByModuleId.set(moduleId, files);
        }
      }
      if (isDevMode || !sriConfig.enabled) return;
      const salt: string[] = [];
      if (sriConfig.runtimePatchDynamicLinks && chunk.isEntry) {
        salt.push(sriRuntimeFingerprint);
        salt.push(SRI_INJECTION_VERSION);
        // The injected call embeds base-derived values (map keys, root, assetBase).
        salt.push(`base:${resolvedConfig?.base ?? "/"}`);
      }
      // 4.0.x cleared these preload lists, so cached copies need new names.
      if (!shouldSkip["script-src-elem"] && chunk.dynamicImports.length > 0) {
        salt.push("vite-plugin-csp-guard:preload-lists-kept");
      }
      return salt.length ? salt.join("\n") : undefined;
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle: Rolldown.OutputBundle) {
        if (!sriConfig.enabled || isDevMode) return;

        // SRI helpers are typed against Rollup's OutputBundle; Vite 8 passes Rolldown's
        // bundle (compatible at runtime, distinct types).
        const rollupBundle = bundle as unknown as RollupOutputBundle;
        const htmlAssets: {
          asset: { type: "asset"; source: string | Buffer };
          html: string;
        }[] = [];

        try {
          if (debug) console.log("[SRI] Processing bundle for lazy chunk SRI...");

          // 1. Build initial integrity map (for non-entry chunks and assets)
          let sriByPathname = buildIntegrityMappings(rollupBundle, algorithm, debug);
          const base = resolvedConfig?.base ?? "/";

          // 2. Inject each entry's reachable-file map before hashing for HTML.
          if (sriConfig.runtimePatchDynamicLinks) {
            const runtime = installSriRuntime.toString();
            const relativeBase = base === "./" || base === "";
            // Full-URL and protocol-relative bases serve assets from another
            // origin; the runtime only applies SRI to URLs on that origin.
            const assetBaseOption =
              base.startsWith("//") || /^[a-z][a-z\d+.-]*:\/\//i.test(base)
                ? `,assetBase:${JSON.stringify(base)}`
                : "";
            for (const [fileName, chunk] of Object.entries(bundle)) {
              if (chunk.type !== "chunk" || !chunk.isEntry || !chunk.code) {
                continue;
              }

              const entryMap: Record<string, string> = {};
              for (const file of collectReachableFiles(
                bundle,
                fileName,
                (id) => this.getModuleInfo(id),
                filesByModuleId,
              )) {
                const integrity = sriByPathname[`/${file}`];
                if (integrity) entryMap[`/${file}`] = integrity;
              }
              const map = JSON.stringify(withBasePathname(entryMap, base));
              // A relative base can be deployed under any path, so resolve the
              // map against the entry chunk's own URL at runtime.
              let options = `${sriRuntimeOptions.slice(0, -1)}${assetBaseOption}}`;
              if (relativeBase) {
                const root =
                  _options.format === "es"
                    ? `new URL(${JSON.stringify(
                        "../".repeat((fileName.match(/\//g) || []).length) || "./",
                      )}, import.meta.url).href`
                    : `typeof document !== "undefined" ? document.baseURI : undefined`;
                options = `${options.slice(0, -1)},root:${root}}`;
              }
              injectRuntimeAndShiftSourceMaps(
                chunk as unknown as OutputChunk,
                rollupBundle,
                `(${runtime})(${map},${options});\n`,
              );
              if (debug) {
                console.log(`[SRI] Injected runtime into entry: ${fileName}`);
              }
            }

            // Rebuild integrity map so entry chunks have correct hashes (with runtime)
            sriByPathname = buildIntegrityMappings(
              rollupBundle,
              algorithm,
              debug,
            );
          }

          const hashReplacements: { old: string; new: string }[] = [];
          for (const [fileName, provisional] of provisionalChunkHashes) {
            const chunk = bundle[fileName];
            if (chunk?.type !== "chunk") continue;
            hashReplacements.push({
              old: `${algorithm}-${provisional}`,
              new: `${algorithm}-${generateHash(chunk.code, algorithm)}`,
            });
          }

          const dynamicChunkFiles = sriConfig.preloadDynamicChunks
            ? analyzeDynamicImports(rollupBundle, debug)
            : new Set<string>();

          // 3. Process HTML assets: add SRI to elements, inject modulepreload links
          for (const [fileName, item] of Object.entries(bundle)) {
            if (
              !fileName.toLowerCase().endsWith(".html") ||
              item.type !== "asset"
            )
              continue;

            const asset = item as { type: "asset"; source: string | Buffer };
            if (!asset.source) continue;

            const html =
              typeof asset.source === "string"
                ? asset.source
                : Buffer.from(asset.source).toString();

            const processed = processHtmlForSri(
              html,
              sriByPathname,
              dynamicChunkFiles,
              base,
              sriConfig.crossorigin,
              sriConfig.skipResources,
              debug,
              hashReplacements,
              fileName,
            );

            htmlAssets.push({ asset, html: processed });
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.error(
            new Error(`SRI processing failed: ${message}`, { cause: e }),
          );
        }

        for (const { asset, html } of htmlAssets) {
          asset.source = applyPendingTransformPolicy(
            html,
            cspContext,
            transformPolicy,
          );
        }
      },
    },
    transformIndexHtml: {
      order: "post",
      handler: async (html, context) => {
        if (features.mpa) {
          // console.log("transformIndexHtml");
        }

        const defaultPolicy = isDevAndAllowed()
          ? DEFAULT_DEV_POLICY
          : DEFAULT_POLICY;

        // Use environment-specific override if set, otherwise fall back to top-level override
        const shouldOverride = isDevAndAllowed()
          ? (devOverride ?? override)
          : (buildOverride ?? override);
        const effectivePolicy = mergePolicies(
          defaultPolicy,
          policy,
          shouldOverride,
        );

        // Update the effective policy in the context
        cspContext.policy = effectivePolicy;

        return transformIndexHtmlHandler({
          html,
          context,
          pluginContext,
          isTransformationStatusEmpty: isTransformationStatusEmpty(),
          cspContext,
          sri: sriConfig.enabled,
          provisionalChunkHashes,
          transformPolicy,
        });
      },
    },
    onLog(_level, log) {
      if (log.plugin === "vite-plugin-csp-guard") {
        this.warn(log);
      }
    },
    moduleParsed: (info) =>
      // This handleModuleParsed function is not ready for production
      features.cssInJs ? unstable_handleModuleParsed({ info }) : undefined,
    configureServer(thisServer) {
      server = thisServer;
    },
  };
}
