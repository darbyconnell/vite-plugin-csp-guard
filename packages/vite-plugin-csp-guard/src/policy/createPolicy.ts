import { HtmlTagDescriptor } from "vite";
import { HashCollection } from "../types";
import { policyToString, type CSPPolicy, type DefinedPolicy } from "csp-toolkit";
import { cspSkipElemInherit, policyHasUnsafeInline } from "./keywordForm";

const ELEM_PARENT_MAP = {
  "script-src-elem": "script-src",
  "style-src-elem": "style-src",
} as const;

type GeneratePolicyProps = {
  policy: CSPPolicy | DefinedPolicy;
  collection: HashCollection;
  userPolicy?: CSPPolicy | DefinedPolicy;
};
export const generatePolicyString = ({
  collection,
  policy,
  userPolicy,
}: GeneratePolicyProps) => {
  const finalPolicy = { ...policy };
  const userPolicyDirectives = new Set(
    Object.keys(userPolicy ?? {}).map((key) =>
      key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).toLowerCase(),
    ),
  );

  // Generate the final policy
  for (const [key, value] of Object.entries(collection)) {
    const currentMap = value;
    if (currentMap.size === 0) continue;

    const policyKey = key as keyof CSPPolicy;
    const currentPolicy = finalPolicy[policyKey] ?? [];
    const parentKey = ELEM_PARENT_MAP[key as keyof typeof ELEM_PARENT_MAP];
    const elementPolicyIsDefined = finalPolicy[policyKey] !== undefined;
    const elementDirectiveIsExplicit = userPolicyDirectives.has(key);
    let inheritedSources: string[] = [];

    if (parentKey && !elementDirectiveIsExplicit) {
      const parentSources = finalPolicy[parentKey];
      const sourcesToInherit = elementPolicyIsDefined
        ? (parentSources ?? [])
        : (parentSources ?? finalPolicy["default-src"] ?? []);
      inheritedSources = sourcesToInherit.filter(
        (source) =>
          !cspSkipElemInherit.has(source) && !currentPolicy.includes(source),
      );
    } else if (parentKey && !elementPolicyIsDefined) {
      // Explicitly configured missing directives start empty; they do not
      // inherit a parent or default-src fallback.
      inheritedSources = [];
    }

    if (policyHasUnsafeInline([...currentPolicy, ...inheritedSources])) {
      // Preserve unsafe-inline when the list has no hash, nonce, or strict-dynamic.
      if (inheritedSources.length > 0) {
        finalPolicy[policyKey] = [...currentPolicy, ...inheritedSources];
      }
      continue;
    }

    finalPolicy[policyKey] = [
      ...currentPolicy,
      ...inheritedSources,
      ...Array.from(currentMap.keys()),
    ];
  }
  // Create the policy string
  const policyString = policyToString(finalPolicy);

  return policyString;
};

export const policyToTag = (policy: string): HtmlTagDescriptor[] => {
  return [
    {
      tag: "meta",
      attrs: {
        "http-equiv": "Content-Security-Policy",
        content: policy,
      },
      injectTo: "head-prepend",
    },
  ];
};
