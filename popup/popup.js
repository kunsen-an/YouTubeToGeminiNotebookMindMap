const ui = {
  loading: document.querySelector("#loading"),
  notYoutube: document.querySelector("#not-youtube"),
  panel: document.querySelector("#video-panel"),
  thumbnail: document.querySelector("#thumbnail"),
  title: document.querySelector("#title"),
  channel: document.querySelector("#channel"),
  error: document.querySelector("#error"),
  progress: document.querySelector("#progress"),
  addButton: document.querySelector("#add-button"),
  copyDebugButton: document.querySelector("#copy-debug-button"),
  downloadDebugButton: document.querySelector("#download-debug-button"),
  downloadDebugButtonMuted: document.querySelector("#download-debug-button-muted"),
  debugCopyStatus: document.querySelector("#debug-copy-status")
};

let activeTab;
let videoInfo;

init();

async function init() {
  activeTab = await getActiveTab();

  ui.copyDebugButton?.addEventListener("click", copyDebugLog);
  ui.downloadDebugButton?.addEventListener("click", downloadDebugLog);
  ui.downloadDebugButtonMuted?.addEventListener("click", downloadDebugLog);

  if (!activeTab?.url || !isYouTubeWatchUrl(activeTab.url)) {
    if (activeTab?.url && isGeminiNotebookUrl(activeTab.url)) {
      showNotebookProgressView();
      await restoreProgress({ clearCompleted: true });
      return;
    }
    showOnly(ui.notYoutube);
    return;
  }

  try {
    videoInfo = await sendMessageToTab(activeTab.id, { type: "YT_GET_VIDEO_INFO" });
    renderVideoInfo(videoInfo);
    await restoreProgress({ clearCompleted: true });
  } catch (error) {
    showPanelError("動画情報を取得できませんでした。ページを再読み込みしてからもう一度お試しください。");
    console.error(error);
  }
}

ui.addButton.addEventListener("click", async () => {
  if (!videoInfo) return;

  resetProgress();
  setBusy(true);
  addProgress("Gemini Notebook を準備しています");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_NOTEBOOKLM_FLOW",
      payload: videoInfo
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Gemini Notebook への追加に失敗しました。");
    }
  } catch (error) {
    addProgress(error.message || "処理中にエラーが発生しました。", "error");
    setBusy(false);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "FLOW_STATUS") return;

  if (message.kind === "error") {
    addProgress(message.text, "error");
    setBusy(false);
    return;
  }

  addProgress(message.text, message.kind);
  if (message.kind === "done") {
    setBusy(false);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.flowStatus?.newValue) return;
  renderProgress(changes.flowStatus.newValue);
});

function renderVideoInfo(info) {
  showOnly(ui.panel);
  ui.thumbnail.src = info.thumbnailUrl || "";
  ui.thumbnail.alt = info.title ? `${info.title} のサムネイル` : "動画サムネイル";
  ui.title.textContent = info.title || "タイトルを取得できませんでした";
  ui.channel.textContent = info.channelName || "チャンネル名を取得できませんでした";

  if (!info.hasCaptions) {
    showError("字幕がないため追加できません");
    ui.addButton.disabled = true;
  }
}

function showPanelError(text) {
  showOnly(ui.panel);
  showError(text);
  ui.addButton.disabled = true;
}

function showError(text) {
  ui.error.hidden = false;
  ui.error.textContent = text;
}

function resetProgress() {
  ui.progress.replaceChildren();
  ui.error.hidden = true;
  setDebugStatus("");
}

function addProgress(text, kind = "info") {
  const item = document.createElement("li");
  item.textContent = text;
  item.dataset.kind = kind;
  ui.progress.append(item);
}

async function restoreProgress({ clearCompleted = false } = {}) {
  const { flowStatus = [] } = await chrome.storage.local.get({ flowStatus: [] });
  const lastEntry = flowStatus[flowStatus.length - 1];
  if (clearCompleted && lastEntry?.kind === "done") {
    await chrome.storage.local.set({ flowStatus: [], debugLog: [] });
    renderProgress([]);
    return;
  }
  renderProgress(flowStatus);
}

function renderProgress(entries) {
  ui.progress.replaceChildren();
  for (const entry of entries) {
    addProgress(entry.text, entry.kind);
  }
}

async function copyDebugLog() {
  const data = await getDebugPayload();
  const text = JSON.stringify(data, null, 2);

  try {
    await navigator.clipboard.writeText(text);
    setDebugStatus(`コピーしました: 進捗 ${data.flowStatus.length} 件 / 詳細 ${data.debugLog.length} 件`);
  } catch {
    setDebugStatus("コピーできませんでした。JSONファイル保存を使ってください。");
  }
}

async function downloadDebugLog() {
  const data = await getDebugPayload();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_DEBUG_LOG",
      payload: data
    });

    if (!response?.ok) {
      throw new Error(response?.error || "JSONファイルを保存できませんでした。");
    }

    setDebugStatus(`保存先を選ぶ画面を開きました: 進捗 ${data.flowStatus.length} 件 / 詳細 ${data.debugLog.length} 件`);
  } catch (error) {
    setDebugStatus(error.message || "JSONファイルを保存できませんでした。");
  }
}

async function getDebugPayload() {
  const data = await chrome.storage.local.get({ flowStatus: [], debugLog: [] });
  return {
    exportedAt: new Date().toISOString(),
    extension: "YouTube to Gemini Notebook Mind Map",
    page: {
      activeTabUrl: activeTab?.url || "",
      videoTitle: videoInfo?.title || "",
      sourceTitle: videoInfo?.sourceTitle || "",
      channelName: videoInfo?.channelName || "",
      videoUrl: videoInfo?.url || "",
      videoLanguageCode: videoInfo?.languageCode || ""
    },
    flowStatus: data.flowStatus,
    debugLog: data.debugLog
  };
}

function setDebugStatus(text) {
  if (ui.debugCopyStatus) ui.debugCopyStatus.textContent = text;
}

function setBusy(isBusy) {
  ui.addButton.disabled = isBusy || !videoInfo?.hasCaptions;
  ui.addButton.textContent = isBusy ? "処理中..." : "Gemini Notebookに追加";
}

function showOnly(target) {
  [ui.loading, ui.notYoutube, ui.panel].forEach((element) => {
    element.hidden = element !== target;
  });
}

function isYouTubeWatchUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)youtube\.com$/.test(parsed.hostname) && parsed.pathname === "/watch";
  } catch {
    return false;
  }
}

function isGeminiNotebookUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "notebook.google.com" || hostname === "notebooklm.google.com";
  } catch {
    return false;
  }
}

function showNotebookProgressView() {
  showOnly(ui.panel);
  ui.thumbnail.hidden = true;
  ui.title.textContent = "Gemini Notebook の処理状況";
  ui.channel.textContent = "新しい動画を追加する場合は、YouTube の動画ページでアイコンを開いてください。";
  ui.error.hidden = true;
  ui.addButton.hidden = true;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendMessageToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}
