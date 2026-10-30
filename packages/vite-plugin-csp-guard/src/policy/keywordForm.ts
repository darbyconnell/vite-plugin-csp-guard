import { unsafeEval, unsafeInline } from "csp-toolkit";

/**
 * How a keyword token (e.g. from `self`, `unsafeEval`) appears in normalized
 * CSPPolicy / definePolicy source arrays: wrapped in single quotes, e.g.
 * `"'self'"`, `"'unsafe-eval'"`.
 */
export function cspKeywordForm(token: string): string {
  return "'" + token + "'";
}

export const cspSkipElemInherit = new Set([cspKeywordForm(unsafeEval)]);

function normalizeSource(source: string): string {
  return source.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}

function hasHashNonceOrStrictDynamic(list: string[]): boolean {
  return list.some((source) => {
    const normalized = normalizeSource(source);
    return (
      /^(sha256|sha384|sha512)-/.test(normalized) ||
      normalized.startsWith("nonce-") ||
      normalized === "strict-dynamic"
    );
  });
}

export function policyHasUnsafeInline(
  list: string[] | undefined,
): boolean {
  return (
    list?.some((source) => normalizeSource(source) === unsafeInline) === true &&
    !hasHashNonceOrStrictDynamic(list ?? [])
  );
}

export function policyHasUnsafeEval(
  list: string[] | undefined,
): boolean {
  return list?.includes(cspKeywordForm(unsafeEval)) ?? false;
}
