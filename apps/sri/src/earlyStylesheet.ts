import earlyCssUrl from "./early.css?url";

const link = document.createElement("link");
link.rel = "stylesheet";
link.href = earlyCssUrl;
link.dataset.earlySri = "true";

const outcome = new Promise<"load" | "error">((resolve) => {
  link.addEventListener("load", () => resolve("load"), { once: true });
  link.addEventListener("error", () => resolve("error"), { once: true });
});
(
  window as Window & { earlySriStylesheet?: Promise<"load" | "error"> }
).earlySriStylesheet = outcome;
document.head.appendChild(link);
