(() => {
  const VERSION = "2026-07-29-main-fill-v2";
  if (window.__YT2NLM_PAGE_LOGGER_VERSION__ === VERSION) return;
  window.__YT2NLM_PAGE_LOGGER_VERSION__ = VERSION;

  window.addEventListener("__YT2NLM_DEBUG__", (event) => {
    const detail = event.detail || {};
    const label = detail.label || "debug";
    const data = detail.data;
    const timestamp = detail.timestamp || new Date().toISOString();

    if (data === undefined) {
      console.log(`[YT2NLM:PAGE] ${timestamp} ${label}`);
      return;
    }

    console.groupCollapsed(`[YT2NLM:PAGE] ${timestamp} ${label}`);
    console.log(data);
    console.groupEnd();
  });

  window.addEventListener("__YT2NLM_FILL_TEXT__", (event) => {
    const detail = event.detail || {};
    const targetId = detail.targetId;
    const value = String(detail.value || "");
    const selector = `[data-yt2nlm-target="${CSS.escape(targetId)}"]`;
    const element = targetId ? document.querySelector(selector) : null;

    if (!element) {
      console.warn("[YT2NLM:PAGE] fill target not found", { targetId });
      return;
    }

    fillTextControl(element, value);
    console.log("[YT2NLM:PAGE] filled text control", {
      targetId,
      tag: element.tagName.toLowerCase(),
      value: element.value,
      valueLength: element.value?.length || 0
    });
  });

  function fillTextControl(element, value) {
    element.focus();
    element.select?.();

    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

    try {
      document.execCommand("delete", false);
    } catch {
      // Fall back to the native value setter below.
    }

    if (element.value) {
      setter?.call(element, "");
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "deleteContentBackward",
        data: null
      }));
    }

    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, value);
    } catch {
      inserted = false;
    }

    if (!inserted || element.value !== value) {
      setter?.call(element, value);
      element.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value
      }));
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value
      }));
    }

    element.dispatchEvent(new Event("change", { bubbles: true }));

    // Enterは呼び出し元で一度だけ送る。ここでも送るとURL入力欄で
    // 古い候補の確定や二重送信が起きることがある。
  }

  console.log("[YT2NLM:PAGE] logger installed", VERSION);
})();
