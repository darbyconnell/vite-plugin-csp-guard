import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { installSriRuntime } from "../src/sri/runtime";

class FakeNode {
  appendChild(node: any) {
    node.isConnected = true;
    return node;
  }
}

class FakeElement extends FakeNode {
  nodeType = 1;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  localName: string;
  nodeName: string;
  isConnected = false;
  firstElementChild = null;
  private attributes = new Map<string, string>();

  constructor(localName: string) {
    super();
    this.localName = localName;
    this.nodeName = localName.toUpperCase();
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  querySelectorAll() {
    return [];
  }
}

describe("installSriRuntime URL-encoded filenames", () => {
  test.each([false, true])("matches encoded paths with relative root: %s", (relativeRoot) => {
    const integrity = "sha256-runtime-encoded";
    const document = { baseURI: "https://example.test/index.html" };
    const sriByPathname = { "/assets/café file.js": integrity };
    const options = relativeRoot ? { root: "https://example.test/" } : {};

    runInNewContext(
      `(${installSriRuntime.toString()})(sriByPathname, options)`,
      {
        sriByPathname,
        options,
        document,
        location: { href: document.baseURI },
        URL,
        Element: FakeElement,
        Node: FakeNode,
      },
    );

    const script = new FakeElement("script");
    script.setAttribute("src", "/assets/caf%C3%A9%20file.js");
    new FakeNode().appendChild(script);

    expect(script.getAttribute("integrity")).toBe(integrity);
  });
});
