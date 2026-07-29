const NOTEBOOK_URL = "https://notebook.google.com/";
const NOTEBOOK_URL_PATTERNS = [
  "https://notebook.google.com/*",
  "https://notebooklm.google.com/*"
];
const NOTEBOOK_CONTENT_VERSION = "2026-07-29-gemini-notebook-v40";

chrome.runtime.onInstalled.addListener(() => {
  clearLogs();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_NOTEBOOKLM_FLOW") {
    runNotebookLmFlow(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        notify("error", error.message || "Gemini Notebook の自動操作に失敗しました。");
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message?.type === "DOWNLOAD_DEBUG_LOG") {
    downloadDebugLog(message.payload)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function runNotebookLmFlow(video) {
  validateVideo(video);
  await clearLogs();
  await chrome.storage.local.set({ pendingNotebookCreationName: "" });
  notify("info", "Gemini Notebook タブを開いて前面にしました");

  const tab = await getOrCreateNotebookLmTab();
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  const currentVersion = await currentNotebookContentVersion(tab.id);
  if (currentVersion !== NOTEBOOK_CONTENT_VERSION) {
    notify("info", "Gemini Notebook タブを再読み込みして最新版の操作スクリプトを準備しています");
    await reloadNotebookTab(tab.id);
  } else {
    notify("info", "Gemini Notebook の最新版操作スクリプトを確認しました");
  }

  notify("info", "Gemini Notebook へデバッグロガーを準備しています");
  await ensureNotebookPageLogger(tab.id);

  await ensureNotebookContentScript(tab.id);

  notify("info", "Gemini Notebook の自動操作を開始します");
  await runNotebookFlowAcrossNavigations(tab.id, video);
}

function validateVideo(video) {
  if (!video?.hasCaptions) {
    throw new Error("字幕がないため追加できません");
  }
  if (!video?.channelName || !video?.url) {
    throw new Error("動画情報が不足しています。YouTube ページを再読み込みしてください。");
  }
}

async function clearLogs() {
  await chrome.storage.local.set({ flowStatus: [], debugLog: [] });
}

async function downloadDebugLog(payload) {
  const text = JSON.stringify(payload || {}, null, 2);
  const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  return chrome.downloads.download({
    url: dataUrl,
    filename: `youtube-to-gemini-notebook-debug-${stamp}.json`,
    saveAs: true,
    conflictAction: "uniquify"
  });
}

async function getOrCreateNotebookLmTab() {
  const tabs = await chrome.tabs.query({ url: NOTEBOOK_URL_PATTERNS });
  if (tabs.length > 0) return tabs[0];
  return chrome.tabs.create({ url: NOTEBOOK_URL, active: true });
}

async function injectNotebookContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/notebooklm.js"]
  });
}

async function ensureNotebookContentScript(tabId) {
  if (await currentNotebookContentVersion(tabId) !== NOTEBOOK_CONTENT_VERSION) {
    notify("info", "Gemini Notebook へ操作スクリプトを注入しています");
    await injectNotebookContentScript(tabId);
  }
  await verifyNotebookContentScript(tabId);
}

async function runNotebookFlowAcrossNavigations(tabId, video) {
  const maximumAttempts = 5;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const result = await sendMessageToTabWithTimeout(tabId, {
        type: "NLM_RUN_FLOW",
        payload: video
      }, 300000);
      if (!result?.ok) {
        throw new Error(
          result?.error ||
          "Gemini Notebook の画面操作に失敗しました。"
        );
      }
      return;
    } catch (error) {
      if (
        !isNavigationMessageChannelClosed(error) ||
        attempt === maximumAttempts
      ) {
        throw error;
      }

      notify(
        "info",
        "Gemini Notebook の画面切り替えを確認しました。処理を継続します"
      );
      await waitForTabComplete(tabId, 30000);
      await ensureNotebookContentScript(tabId);
    }
  }
}

function isNavigationMessageChannelClosed(error) {
  const message = String(error?.message || error || "");
  return /message channel closed|receiving end does not exist|could not establish connection/i
    .test(message);
}

async function verifyNotebookContentScript(tabId) {
  const response = await sendMessageToTabWithTimeout(tabId, { type: "NLM_PING" }, 10000);
  if (response?.version !== NOTEBOOK_CONTENT_VERSION) {
    throw new Error(`Gemini Notebook 操作スクリプトのバージョン確認に失敗しました。期待: ${NOTEBOOK_CONTENT_VERSION} / 実際: ${response?.version || "不明"}`);
  }
}

async function currentNotebookContentVersion(tabId) {
  try {
    const response = await sendMessageToTabWithTimeout(
      tabId,
      { type: "NLM_PING" },
      2500
    );
    return response?.version || "";
  } catch {
    return "";
  }
}

async function ensureNotebookPageLogger(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["content/pageLogger.js"]
    });
  } catch (error) {
    notify("info", `DevTools 用ログ注入をスキップしました: ${error.message}`);
  }
}

async function reloadNotebookTab(tabId) {
  await chrome.tabs.reload(tabId);
  await waitForTabComplete(tabId, 30000);
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const currentTab = await chrome.tabs.get(tabId);
  if (currentTab?.status === "complete") return;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (timeoutId != null) clearTimeout(timeoutId);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (
        updatedTabId === tabId &&
        (changeInfo?.status === "complete" || tab?.status === "complete")
      ) {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    timeoutId = setTimeout(() => {
      finish(new Error("Gemini Notebook タブの読み込みがタイムアウトしました。"));
    }, timeoutMs);

    // リスナー登録直前に読み込みが完了する競合を、状態の再取得で解消する。
    chrome.tabs.get(tabId)
      .then((tab) => {
        if (tab?.status === "complete") finish();
      })
      .catch(finish);
  });
}

function sendMessageToTabWithTimeout(tabId, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Gemini Notebook から応答がありませんでした: ${message.type}`));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message).then(
      (response) => {
        clearTimeout(timeoutId);
        resolve(response);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function notify(kind, text) {
  const entry = { kind, text, at: Date.now() };
  chrome.storage.local.get({ flowStatus: [] }).then(({ flowStatus }) => {
    const nextStatus = [...flowStatus, entry].slice(-50);
    return chrome.storage.local.set({ flowStatus: nextStatus });
  }).catch(() => {});
  chrome.runtime.sendMessage({ type: "FLOW_STATUS", ...entry }).catch(() => {});
}
