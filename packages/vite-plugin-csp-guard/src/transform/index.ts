import type {
  IndexHtmlTransformContext,
  Rolldown,
  ViteDevServer,
} from "vite";
import { addHash, generateHash } from "../policy/core";
import * as cheerio from "cheerio";
import {
  type CSPPluginContext,
  type MyPluginOptions,
  TransformationStatus,
  type TransformPolicyMeta,
} from "../types";
import { handleCSPInsert, handleIndexHtml } from "./handleIndexHtml";
import { generatePolicyString } from "../policy/createPolicy";
import { cssFilter, jsFilter, preCssFilter, tsFilter } from "../utils";
import { getCSS } from "../css/extraction";

export interface TransformHandlerProps {
  code: string;
  id: string;
  cspContext: CSPPluginContext;
  transformationStatus: TransformationStatus;
  transformMode: "pre" | "post"; // Lets us know if we are in the pre or post transform
  server?: ViteDevServer; // This is the ViteDevServer, if this exists it means we are in dev mode
}

export const transformHandler = async ({
  code,
  id,
  cspContext,
  transformationStatus,
  transformMode,
  server,
}: TransformHandlerProps) => {
  const { algorithm, collection } = cspContext;

  if (!server) return null; // Exit early if we are not in dev mode
  const isCss = cssFilter(id);
  const isPreCss = preCssFilter(id);
  const isJs = jsFilter(id);
  const isTs = tsFilter(id);

  const isAllTransformed = () =>
    Array.from(transformationStatus.values()).every((value) => value === true);

  const handleCSS = () => {
    const currentCode = transformMode === "pre" ? code : getCSS(code);

    const hash = generateHash(currentCode, algorithm);

    addHash({
      hash,
      key: "style-src-elem",
      data: {
        algorithm,
        content: code,
      },
      collection: collection,
    });
    transformationStatus.set(id, true);
  };

  const handleJS = () => {
    const hash = generateHash(code, algorithm);
    addHash({
      hash,
      key: "script-src-elem",
      data: {
        algorithm,
        content: code,
      },
      collection: collection,
    });
    transformationStatus.set(id, true);
  };

  if (transformationStatus.has(id)) {
    if (isJs || isTs) {
      handleJS();
    } else if (isCss || isPreCss) {
      handleCSS();
    } else {
      // Do nothing
    }
  } else {
    //Files that are deps of the entry points that are loaded in the load() hook

    if (isJs) {
      handleJS();
    } else if (isCss || isPreCss) {
      handleCSS();
    } else {
      // Do nothing
    }
  }

  if (isAllTransformed() && (isCss || isJs)) {
    await server.transformIndexHtml("/index.html", "", "/");
    server.ws.send({
      type: "full-reload",
    });
  }

  return null;
};

export interface TransformIndexHtmlHandlerProps {
  html: string;
  context: IndexHtmlTransformContext;
  pluginContext: Rolldown.PluginContext | undefined;
  isTransformationStatusEmpty: boolean;
  cspContext: CSPPluginContext;
  sri: boolean;
  provisionalChunkHashes?: Map<string, string>;
  transformPolicy?: MyPluginOptions["transformPolicy"];
}

export const PENDING_POLICY_ATTR = "data-csp-guard-pending";

export const transformIndexHtmlHandler = ({
  html,
  context: { server, bundle, chunk, path, filename },
  pluginContext,
  isTransformationStatusEmpty,
  cspContext,
  sri,
  provisionalChunkHashes,
  transformPolicy,
}: TransformIndexHtmlHandlerProps) => {
  const { algorithm, policy, collection, shouldSkip } = cspContext;

  if (isTransformationStatusEmpty && server) {
    //Return early if there are no transformations and we are in dev mode
    return;
  }

  if (bundle && sri) {
    for (const fileName of Object.keys(bundle)) {
      const currentFile = bundle[fileName];

      if (currentFile) {
        if (currentFile.type === "chunk" && !shouldSkip["script-src-elem"]) {
          // Provisional; replaced with the final code hash in generateBundle.
          const hash = generateHash(currentFile.code, algorithm);

          provisionalChunkHashes?.set(fileName, hash);

          if (!collection["script-src-elem"].has(`${algorithm}-${hash}`)) {
            addHash({
              hash,
              key: "script-src-elem",
              data: {
                algorithm,
                content: "",
              },
              collection: collection,
            });
          }
        }
      }
    }
  }

  const { html: newHtml, HASH_COLLECTION: updatedCollection } = handleIndexHtml(
    {
      html,
      algorithm,
      collection,
      policy,
      context: pluginContext,
    },
  );

  const rawPolicy = generatePolicyString({
    collection: updatedCollection,
    policy: policy,
  });

  if (transformPolicy && bundle && sri) {
    return {
      html: handleCSPInsert(newHtml, rawPolicy, PENDING_POLICY_ATTR),
      tags: [],
    };
  }

  const effectivePolicyString = applyTransformPolicy(
    rawPolicy,
    cspContext,
    transformPolicy,
  );
  const changedHtml =
    effectivePolicyString != null
      ? handleCSPInsert(newHtml, effectivePolicyString)
      : newHtml;
  return {
    html: changedHtml,
    tags: [],
  };
  // Vite 6 and probably 7 don't support below
  // const InjectedHtmlTags = policyToTag(policyString);
  // return {
  //   html: newHtml,
  //   tags: InjectedHtmlTags,
  // };
};

const applyTransformPolicy = (
  rawPolicy: string,
  cspContext: CSPPluginContext,
  transformPolicy: MyPluginOptions["transformPolicy"],
): string | null => {
  if (!transformPolicy) return rawPolicy;
  const meta: TransformPolicyMeta = {
    command: cspContext.isDevMode ? "serve" : "build",
    algorithm: cspContext.algorithm,
  };
  const result = transformPolicy(rawPolicy, meta);
  return result === undefined ? rawPolicy : result;
};

export const applyPendingTransformPolicy = (
  html: string,
  cspContext: CSPPluginContext,
  transformPolicy: MyPluginOptions["transformPolicy"],
): string => {
  const $ = cheerio.load(html);
  const pending = $(`meta[${PENDING_POLICY_ATTR}]`);
  if (!pending.length) return html;
  pending.each((_, element) => {
    const $element = $(element);
    const result = applyTransformPolicy(
      $element.attr("content") ?? "",
      cspContext,
      transformPolicy,
    );
    if (result == null) {
      $element.remove();
      return;
    }
    $element.attr("content", result);
    $element.removeAttr(PENDING_POLICY_ATTR);
  });
  return $.html();
};
