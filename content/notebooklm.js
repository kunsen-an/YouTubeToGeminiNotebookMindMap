const DEBUG_PREFIX = "[YT2NLM]";
const NOTEBOOK_HOME_URL = "https://notebook.google.com/";
const NOTEBOOK_CONTENT_VERSION = "2026-07-29-gemini-notebook-v40";
const PENDING_NOTEBOOK_CREATION_KEY = "pendingNotebookCreationName";
const JAPANESE_MIND_MAP_INSTRUCTION =
  "動画の内容を日本語で整理し、マインドマップ全体を日本語で作成してください。";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "NLM_PING") {
    sendResponse({ ok: true, version: NOTEBOOK_CONTENT_VERSION });
    return true;
  }

  if (message?.type !== "NLM_RUN_FLOW") return false;

  runFlow(message.payload)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function runFlow(video) {
  await waitForDocumentReady();
  debug("flow:start", {
    video,
    url: location.href,
    title: document.title
  });
  snapshotState("flow-start");
  status("Gemini Notebook の画面を確認しています");

  const notebookTitle = String(video.channelName || "").trim();
  if (!notebookTitle || !video.url) {
    throw new Error("YouTube動画情報が不足しているためGemini Notebookへ追加できません。YouTubeページを再読み込みしてからやり直してください。");
  }
  status(`YouTube チャンネル名: 「${notebookTitle}」`);
  await openOrCreateNotebook(notebookTitle);
  await addYouTubeSource(video, notebookTitle);
  await startMindMapV2(
    notebookTitle,
    video.title,
    video.languageCode
  );

  status(`ノートブック「${notebookTitle}」でマインドマップの生成を開始しました`, "done");
}

async function openOrCreateNotebook(name) {
  status(`ノートブック「${name}」を探しています`);
  await waitUntilHomeOrNotebook();
  snapshotState("after-home-or-notebook-wait");

  if (isNotebookPage()) {
    const currentTitle = visibleNotebookTitle();
    const pendingName = await pendingNotebookCreationName();
    if (
      shouldAdoptPendingUntitledNotebook(
        currentTitle,
        pendingName,
        name
      )
    ) {
      status(`作成途中の無題ノートブックを「${name}」として引き継ぎます`);
      await ensureNotebookTitle(name);
      await clearPendingNotebookCreation();
      return;
    }
    if (isSameNotebookName(currentTitle, name)) {
      await clearPendingNotebookCreation();
      status(`ノートブック「${currentTitle || name}」はすでに開かれています`);
      return;
    }
    status(`別のノートブック「${currentTitle || "名称不明"}」が開いているため、ホームに戻ります`);
    await goHome();
  }

  const existing = await findNotebookCard(name);
  if (existing) {
    const beforeUrl = location.href;
    const foundName = notebookNameFromElement(existing) || name;
    debug("notebook:existing-match", {
      targetName: name,
      foundName,
      element: elementSummary(existing)
    });
    status(`既存ノートブック候補: 「${foundName}」`);
    status(`既存ノートブック「${foundName}」を開いています`);
    await openNotebookElement(existing);
    await waitForNotebookOpen(beforeUrl, foundName);
    await clearPendingNotebookCreation();
    status(`既存ノートブック「${foundName}」を開きました`);
    return;
  }

  status(`ノートブック「${name}」が見つからないため新規作成します`);
  await createNotebook(name);
}

async function waitUntilHomeOrNotebook() {
  await waitFor(() => {
    if (isNotebookPage()) {
      return Boolean(
        findAddSourceButton() &&
        (visibleNotebookTitle() || findNotebookTitleInput())
      );
    }
    return isNotebookHomeReady();
  }, 30000, "Gemini Notebook の画面準備を確認できませんでした。");
}

async function goHome() {
  const homeLink = findClickable([
    "a[href='/']",
    "a[href='https://notebook.google.com/']",
    "a[href='https://notebooklm.google.com/']",
    'a[aria-label*="Gemini Notebook"]',
    'button[aria-label*="Gemini Notebook"]',
    'a[aria-label*="NotebookLM"]',
    'button[aria-label*="NotebookLM"]'
  ]);

  if (homeLink) {
    await clickElement(homeLink);
    await waitFor(() => !isNotebookPage(), 15000).catch(() => {});
    return;
  }

  location.assign(NOTEBOOK_HOME_URL);
  await waitFor(() => !isNotebookPage(), 15000).catch(() => {});
}

async function findNotebookCard(name) {
  await waitFor(
    () => isNotebookHomeReady(),
    30000,
    "Gemini Notebook のホーム画面を確認できませんでした。"
  );
  const target = normalize(name);

  const titleMatches = [
    ...document.querySelectorAll("h1, h2, h3, [role='heading'], .title, [class*='title']")
  ].filter((element) => normalize(element.textContent) === target);

  for (const title of titleMatches) {
    const clickable = closestClickable(title);
    if (clickable) return clickable;
  }

  const candidates = [
    ...document.querySelectorAll("a, button, [role='button'], mat-card, .mat-mdc-card, [role='gridcell'], [class*='card']")
  ]
    .filter((element) => !isHidden(element) && !isDisabled(element))
    .map((element) => closestClickable(element) || element)
    .filter((element, index, array) => array.indexOf(element) === index);

  debug("notebook:candidates", {
    targetName: name,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 30).map((element) => ({
      parsedName: notebookNameFromElement(element),
      summary: elementSummary(element)
    }))
  });

  const exactCandidates = candidates.filter((element) => isSameNotebookName(notebookNameFromElement(element), name));
  if (exactCandidates.length > 0) {
    return exactCandidates.sort((a, b) => scoreNotebookCandidate(a, target) - scoreNotebookCandidate(b, target))[0];
  }

  const similarNames = candidates
    .map((element) => notebookNameFromElement(element))
    .filter((candidateName) => candidateName && normalize(candidateName).includes(target))
    .filter((candidateName, index, array) => array.indexOf(candidateName) === index)
    .slice(0, 3);

  if (similarNames.length > 0) {
    status(`似た名前のノートブックは見つかりましたが、チャンネル名「${name}」と完全一致しないため使いません: 「${similarNames.join("」, 「")}」`);
  }

  return null;
}

function isNotebookHomeReady() {
  if (isNotebookPage()) return false;
  if (document.readyState === "loading") return false;

  const loading = [...document.querySelectorAll(
    "[aria-busy='true'], mat-progress-spinner, mat-spinner, [role='progressbar'], [class*='skeleton'], [class*='shimmer']"
  )].some((element) => !isHidden(element));
  if (loading) return false;

  const notebookCards = document.querySelector(
    "a[href*='/notebook/'], .project-button-card, [class*='notebook-card']"
  );
  if (notebookCards) return true;

  const emptyListContainer = document.querySelector(
    "[class*='project-list'], [class*='projects-list'], [class*='notebook-list']"
  );
  const text = normalize(document.body?.textContent || "");
  const explicitEmptyState =
    /ノートブックがありません|まだノートブックはありません|最初のノートブック|no notebooks|create your first notebook/.test(text);
  return Boolean(emptyListContainer && explicitEmptyState);
}

function shouldAdoptPendingUntitledNotebook(
  currentTitle,
  pendingName,
  targetName
) {
  return Boolean(
    pendingName &&
    isSameNotebookName(pendingName, targetName) &&
    isUntitledNotebookName(currentTitle)
  );
}

function isUntitledNotebookName(name) {
  const normalized = normalize(name);
  return !normalized ||
    /^(無題のノートブック|無題|untitled notebook|untitled)$/.test(normalized);
}

async function pendingNotebookCreationName() {
  const result = await chrome.storage.local.get({
    [PENDING_NOTEBOOK_CREATION_KEY]: ""
  });
  return cleanText(result[PENDING_NOTEBOOK_CREATION_KEY] || "");
}

async function markPendingNotebookCreation(name) {
  await chrome.storage.local.set({
    [PENDING_NOTEBOOK_CREATION_KEY]: cleanText(name)
  });
}

async function clearPendingNotebookCreation() {
  await chrome.storage.local.set({
    [PENDING_NOTEBOOK_CREATION_KEY]: ""
  });
}

function scoreNotebookCandidate(element, target) {
  const text = normalize(element.textContent);
  let score = text.length;
  if (text === target) score -= 1000;
  if (element.matches("a, button, [role='button']")) score -= 100;
  return score;
}

async function openNotebookElement(element) {
  const link = notebookLinkFromElement(element);
  const href = link?.getAttribute("href") || "";
  debug("notebook:open-element", {
    href,
    element: elementSummary(element),
    link: elementSummary(link)
  });

  if (link) {
    link.scrollIntoView({ block: "center", inline: "center" });
    link.focus?.();
    link.click();
    return;
  }

  await clickElement(element);
}

function notebookLinkFromElement(element) {
  if (!element) return null;
  if (element.matches?.("a[href*='/notebook/']")) {
    return element;
  }

  const link = element.querySelector?.("a[href*='/notebook/']");
  if (link) return link;

  return element.closest?.("a[href*='/notebook/']") || null;
}

async function createNotebook(name) {
  snapshotState("before-create-notebook");
  const createButton = await waitForClickableByText([
    "新規作成",
    "新しいノートブック",
    "Create new",
    "New notebook",
    "Create"
  ]);
  const beforeUrl = location.href;
  debug("create:notebook-button", elementSummary(createButton));
  await markPendingNotebookCreation(name);
  await clickElement(createButton);
  snapshotState("after-create-button-click");

  if (isNotebookPage()) {
    await ensureNotebookTitle(name);
    await clearPendingNotebookCreation();
    snapshotState("after-create-notebook-opened");
    status(`ノートブック「${name}」を作成しました`);
    return;
  }

  const nameInput = await waitForInput([
    'input[aria-label*="タイトル"]',
    'input[aria-label*="名前"]',
    'input[aria-label*="title" i]',
    'input[aria-label*="name" i]',
    "input",
    "textarea"
  ]);

  setAngularValue(nameInput, name);
  debug("create:name-input-filled", {
    targetName: name,
    input: elementSummary(nameInput),
    value: nameInput.value
  });
  status(`新規ノートブック名に「${name}」を入力しました`);

  const confirm = await waitForClickableByText([
    "作成",
    "完了",
    "Create",
    "Done"
  ]);
  debug("create:confirm-button", elementSummary(confirm));
  await clickElement(confirm);
  await waitForNotebookOpen(beforeUrl, name);
  await ensureNotebookTitle(name);
  await clearPendingNotebookCreation();
  snapshotState("after-create-notebook-opened");
  status(`ノートブック「${name}」を作成しました`);
}

async function ensureNotebookTitle(name) {
  const currentTitle = visibleNotebookTitle();
  if (isSameNotebookName(currentTitle, name)) {
    debug("notebook:title-already-set", { name, currentTitle });
    return;
  }

  const titleInput = await waitFor(() => findNotebookTitleInput(), 15000, `ノートブック名の入力欄が見つかりませんでした。現在URL: ${location.href}`);
  debug("notebook:title-input", {
    targetName: name,
    currentTitle,
    input: elementSummary(titleInput)
  });

  await fillAngularTextInput(titleInput, name);
  pressEnter(titleInput);
  titleInput.blur?.();
  titleInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));

  try {
    await waitFor(() => isSameNotebookName(visibleNotebookTitle(), name) || isSameNotebookName(titleInput.value, name), 10000);
  } catch {
    snapshotState("notebook-title-set-failed");
    throw new Error(`ノートブック名を「${name}」に設定できませんでした。現在の名前: 「${visibleNotebookTitle() || titleInput.value || "取得できませんでした"}」。無題ノートブックを増やさないため処理を停止します。`);
  }

  debug("notebook:title-set", {
    targetName: name,
    visibleTitle: visibleNotebookTitle(),
    input: elementSummary(titleInput)
  });
}

function findNotebookTitleInput() {
  const inputs = [...document.querySelectorAll("input, textarea")]
    .filter((element) => !isHidden(element) && !element.disabled && !element.readOnly)
    .filter((element) => !isSourceSearchInput(element))
    .filter((element) => {
      const text = normalize(`${element.className || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("placeholder") || ""}`);
      const rect = element.getBoundingClientRect();
      return /title|name|タイトル|名前|title-input/.test(text) ||
        (element.tagName.toLowerCase() === "input" && rect.top < 80 && rect.left < 420);
    });

  return inputs.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return ar.top - br.top || ar.left - br.left;
  })[0] || null;
}

async function addYouTubeSource(video, notebookName) {
  const url = video.url;
  const videoId = normalize(new URL(url).searchParams.get("v") || "");
  const title = sourceMatchTitle(video);
  snapshotState("before-add-youtube-source");
  status(`ノートブック「${notebookName}」に YouTube ソースを追加しています`);
  status(`追加する動画URL: ${url}`);

  let existingSource = findProcessedVideoSourceEntry(videoId, title);
  if (!existingSource) {
    status("同じ動画のソースが既に登録されていないか確認しています");
    existingSource = await revealVideoSourceInVirtualList(videoId, title);
  }

  if (existingSource) {
    debug("source:duplicate-skip", {
      url,
      videoId,
      source: elementSummary(existingSource.item),
      sourcePanel: sourcePanelSummary()
    });
    status("この動画は既にソースへ登録されているため、追加をスキップします");
    await selectOnlyVideoSource(video);
    return;
  }

  const sourceCountBefore = getSourceCount();
  debug("source:count-before", { sourceCountBefore, sourcePanel: sourcePanelSummary() });
  try {

  if (!findSourceDialogRoot()) {
    const addSourceButton = await waitFor(() => findAddSourceButton(), 45000, `ノートブック「${notebookName}」で「ソースを追加」が見つかりませんでした。現在URL: ${location.href}`);
    debug("source:add-button", elementSummary(addSourceButton));
    await clickElement(addSourceButton);
    snapshotState("after-add-source-click");
  } else {
    debug("source:dialog-already-open", elementSummary(findSourceDialogRoot()));
  }

  let urlInput = findSourceUrlInput();
  if (urlInput) {
    debug("source:url-input-visible-before-option-click", elementSummary(urlInput));
  } else {
    const youtubeOption = await waitFor(() => findYouTubeSourceOption(), 30000, `YouTube/ウェブサイトのソース種別が見つかりませんでした。現在URL: ${location.href}`);
    debug("source:youtube-option", elementSummary(youtubeOption));
    await clickElement(youtubeOption);
    snapshotState("after-youtube-option-click");
    urlInput = await waitFor(() => findSourceUrlInput(), 30000, `YouTube URL の入力欄が見つかりませんでした。現在URL: ${location.href}`);
  }

  debug("source:url-input", elementSummary(urlInput));
  await fillAngularTextInput(urlInput, url);
  debug("source:url-input-after-fill", elementSummary(urlInput));
  snapshotState("after-url-input-fill");
  if (urlInput.value !== url) {
    throw new Error(`YouTube URL を入力欄へ反映できませんでした。入力欄の現在値: 「${urlInput.value || "空"}」`);
  }
  pressEnter(urlInput);

  status("YouTube URL の確定ボタンを探しています");
  const insertButton = await waitFor(() => findSourceSubmitButton(), 30000, `ソース追加の確定ボタンが見つかりませんでした。現在URL: ${location.href}`);
  debug("source:insert-button", elementSummary(insertButton));
  await clickSourceSubmitButton(insertButton, url);
  await waitForUrlInputToClose(url);
  await closeAllSourceDialogsIfOpen();

  status(`ノートブック「${notebookName}」でソース処理の完了を待っています`);
  await waitForSourceReady(video, sourceCountBefore);
  await waitForVideoSourceSelectable(video);
  await selectOnlyVideoSource(video);
  await closeSourceDialogIfOpen();
  snapshotState("after-source-ready-wait");
  } finally {
    await closeAllSourceDialogsIfOpen();
  }
}

function findAddSourceButton() {
  const labels = [
    "ソースを追加",
    "ソース追加",
    "追加するソース",
    "Add source",
    "Add sources",
    "Add a source"
  ];

  const byText = findClickableByText(labels);
  if (byText && !isSourcePanelToggle(byText)) return byText;

  const ariaSelectors = [
    'button[aria-label*="ソースを追加"]',
    '[role="button"][aria-label*="ソースを追加"]',
    'button[aria-label*="add source" i]',
    '[role="button"][aria-label*="add source" i]'
  ];
  const byAria = findClickable(ariaSelectors);
  if (byAria && !isSourcePanelToggle(byAria)) return byAria;

  return findIconButtonNearSources();
}

function isSourcePanelToggle(element) {
  const text = normalize(`${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`);
  return /panel|ペイン|パネル|閉じる|開く|toggle|dock_to_right/.test(text);
}

function findSourceDialogRoot() {
  const roots = [
    ...document.querySelectorAll('[role="dialog"], mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane')
  ].filter((element) => !isHidden(element));

  const sourceRoot = roots.reverse().find(isSourceDialogCandidate);

  return sourceRoot || null;
}

function isSourceDialogCandidate(element) {
  if (!element) return false;
  const tooltipSelector =
    "[role='tooltip'], .mat-mdc-tooltip-panel, .mat-tooltip-panel";
  if (
    element.matches?.(tooltipSelector) ||
    element.closest?.(tooltipSelector)
  ) {
    return false;
  }

  const text = normalize(element.textContent);
  if (!/youtube|ウェブサイト|website|url|ソース|source/.test(text)) {
    return false;
  }

  return Boolean(
    element.querySelector?.(
      "input, textarea, button, [role='button'], mat-card, .mat-mdc-card"
    )
  );
}

function sourceDialogSearchRoots() {
  const root = findSourceDialogRoot();
  const roots = [
    root,
    root?.closest(".cdk-overlay-pane"),
    root?.closest(".cdk-overlay-container"),
    document
  ].filter(Boolean);

  return roots.filter((element, index, array) => array.indexOf(element) === index);
}

function findYouTubeSourceOption() {
  const root = findSourceDialogRoot() || document;
  const buttons = [...root.querySelectorAll("button, [role='button'], mat-card, .mat-mdc-card")]
    .filter((element) => !isHidden(element) && !isDisabled(element));

  return buttons.find((button) => {
    const text = normalize(`${button.textContent || ""} ${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
    const icon = normalize(button.querySelector("mat-icon, .material-icons, [class*='icon']")?.textContent);
    return /youtube|ウェブサイト|web site|website/.test(text) || /youtube/.test(icon);
  }) || null;
}

function findSourceUrlInput() {
  const roots = sourceDialogSearchRoots();
  for (const root of roots) {
    const inputs = [...root.querySelectorAll("input, textarea")]
      .filter((element) => !isHidden(element) && !element.disabled && !element.readOnly && isInsideSourceDialogArea(element))
      .filter((element) => !isSourceSearchInput(element));

    const urlLike = inputs.find((element) => {
      const text = normalize(`${element.getAttribute("type") || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("placeholder") || ""}`);
      return /url|youtube|ウェブ|リンク|link/.test(text);
    });

    if (urlLike) return urlLike;
  }

  return null;
}

function isSourceSearchInput(element) {
  const text = normalize(`${element.className || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("placeholder") || ""}`);
  return /query-box|クエリ|検索|search|ソースを検出|detect/.test(text);
}

function findSourceSubmitButton() {
  const buttons = sourceDialogSearchRoots()
    .flatMap((root) => [...root.querySelectorAll("button, [role='button']")])
    .filter((element, index, array) => array.indexOf(element) === index)
    .filter((element) => !isHidden(element))
    .filter((element) => isInsideSourceDialogArea(element));

  debug("source:submit-candidates", buttons.map(elementSummary));

  const enabledButtons = buttons.filter((element) => !isDisabled(element));

  return enabledButtons.find((button) => {
    const text = normalize(`${button.textContent || ""} ${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
    return /挿入|追加|追加する|insert|submit|add source|add/.test(text) && !/ノートブック|notebook|作成|create/.test(text);
  }) || enabledButtons.find((button) => {
    const text = normalize(button.textContent);
    const rect = button.getBoundingClientRect();
    return rect.width >= 48 && rect.width <= 180 && /add|check|done|arrow_forward|east/.test(text);
  }) || null;
}

async function clickSourceSubmitButton(button, url) {
  await clickElement(button);
  const closedAfterFirstClick = await waitFor(
    () => !findUrlInputWithValue(url),
    5000
  ).then(() => true).catch(() => false);
  if (closedAfterFirstClick) return;

  debug("source:submit-did-not-close-url-panel-after-first-click", {
    button: elementSummary(button),
    urlInput: elementSummary(findUrlInputWithValue(url)),
    dialogs: collectSourceDialogSnapshot()
  });

  const retryButton = findSourceSubmitButton() || button;
  await clickElement(retryButton);
  await waitFor(
    () => !findUrlInputWithValue(url),
    8000,
    "YouTube URL の入力画面が閉じませんでした。"
  );
}

function findUrlInputWithValue(url) {
  return [...document.querySelectorAll("input, textarea")]
    .filter((element) => !isHidden(element) && !element.disabled && !element.readOnly)
    .find((element) => element.value === url) || null;
}

async function waitForUrlInputToClose(url) {
  try {
    await waitFor(() => !findUrlInputWithValue(url), 8000);
    debug("source:url-input-closed-after-submit", { url });
  } catch (error) {
    debug("source:url-input-still-open-after-submit", {
      error: error.message,
      urlInput: elementSummary(findUrlInputWithValue(url)),
      dialogs: collectSourceDialogSnapshot()
    });
  }
}

function isInsideSourceDialogArea(element) {
  const root = findSourceDialogRoot();
  if (!root || root === document || root.contains(element)) return true;

  const rootRect = root.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const margin = 80;
  return rect.left >= rootRect.left - margin &&
    rect.right <= rootRect.right + margin &&
    rect.top >= rootRect.top - margin &&
    rect.bottom <= rootRect.bottom + margin;
}

function findIconButtonNearSources() {
  const sourceLabels = [...document.querySelectorAll("h1, h2, h3, [role='heading'], div, span")]
    .filter((element) => !isHidden(element))
    .filter((element) => /^(ソース|sources?)$/i.test(cleanText(element.textContent)));

  for (const label of sourceLabels) {
    const panel = label.closest("aside, section, mat-sidenav, [class*='source'], [class*='panel']") ||
      label.parentElement;
    if (!panel) continue;

    const buttons = [...panel.querySelectorAll("button, [role='button']")]
      .filter((button) => !isHidden(button) && !isDisabled(button));

    const addButton = buttons.find((button) => {
      const text = normalize(`${button.textContent || ""} ${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
      const icon = normalize(button.querySelector("mat-icon, .material-icons, [class*='icon']")?.textContent);
      return /add|\+|追加|ソース|source/.test(text) || icon === "add" || icon === "add_circle";
    });

    if (addButton) return addButton;
  }

  const iconOnlyButtons = [...document.querySelectorAll("button, [role='button']")]
    .filter((button) => !isHidden(button) && !isDisabled(button))
    .filter((button) => {
      const rect = button.getBoundingClientRect();
      const icon = normalize(button.querySelector("mat-icon, .material-icons, [class*='icon']")?.textContent);
      return rect.width <= 72 && rect.height <= 72 && (icon === "add" || icon === "add_circle" || cleanText(button.textContent) === "+");
    });

  return iconOnlyButtons[0] || null;
}

async function startMindMap(notebookName) {
  snapshotState("before-start-mind-map");
  status(`ノートブック「${notebookName}」で Studio のマインドマップを起動しています`);

  const studioTab = findStudioOpenButton();
  debug("mindmap:studio-open-button", studioTab ? elementSummary(studioTab) : null);
  if (studioTab && !findClickableByText(["マインドマップ", "Mind map", "Mind Map"])) {
    await clickElement(studioTab);
    snapshotState("after-studio-tab-click");
  }

  let mindMapButton;
  try {
    mindMapButton = await waitForClickableByText([
      "マインドマップ",
      "Mind map",
      "Mind Map"
    ], 45000);
  } catch (error) {
    snapshotState("mind-map-button-not-found");
    debug("mindmap:clickable-candidates", collectClickableSnapshot(100));
    throw error;
  }

  debug("mindmap:button", elementSummary(mindMapButton));
  await clickElementOnce(mindMapButton);
  snapshotState("after-mind-map-click");
}

function findStudioOpenButton() {
  const buttons = [...document.querySelectorAll("button, [role='button']")]
    .filter((element) => !isHidden(element) && !isDisabled(element));

  return buttons.find((element) => {
    const text = normalize(`${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`);
    return /studio|スタジオ/.test(text) && !/閉じる|close|toggle|panel|パネル|dock_to_left/.test(text);
  }) || null;
}

async function startMindMapV2(notebookName, videoTitle, videoLanguageCode) {
  snapshotState("before-start-mind-map-v2");
  status(`ノートブック「${notebookName}」で Studio のマインドマップを起動しています`);
  const studioTab = findStudioOpenButton();
  debug("mindmap:studio-open-button", studioTab ? elementSummary(studioTab) : null);
  if (studioTab && !findMindMapButton()) {
    await clickElement(studioTab);
    snapshotState("after-studio-tab-click-v2");
  }

  let mindMapButton;
  try {
    mindMapButton = await waitFor(() => findMindMapButton(), 45000, `Studio のマインドマップが見つかりませんでした。現在URL: ${location.href}`);
  } catch (error) {
    snapshotState("mind-map-button-not-found-v2");
    debug("mindmap:clickable-candidates", collectClickableSnapshot(120));
    throw error;
  }

  debug("mindmap:button", elementSummary(mindMapButton));

  // 作成ボタンが操作可能になった時点の一覧を基準として記録する。
  const artifactsBeforeList = findGeneratedMindMapArtifacts();
  const artifactsBefore = new Set(artifactsBeforeList);
  const mindMapsBefore = captureMindMapList();
  debug("mindmap:artifacts-before", {
    count: mindMapsBefore.length,
    cards: mindMapsBefore.map(mindMapListEntryForLog)
  });

  await clickElementOnce(mindMapButton);
  await completeMindMapTopicDialog(videoTitle, videoLanguageCode);
  await waitForMindMapStarted(artifactsBefore);
  const completedArtifact = await waitForNewMindMapCompleted(
    mindMapsBefore
  );
  await renameGeneratedMindMap(
    videoTitle || notebookName,
    mindMapsBefore,
    completedArtifact
  );
  snapshotState("after-mind-map-click-v2");
}

async function completeMindMapTopicDialog(videoTitle, videoLanguageCode) {
  const topicInput = await waitFor(() => {
    return [...document.querySelectorAll("input, textarea")]
      .filter((element) => !isHidden(element) && !element.disabled && !element.readOnly)
      .find((element) => {
        const text = normalize(
          `${element.getAttribute("aria-label") || ""} ${element.getAttribute("placeholder") || ""}`
        );
        return /希望するトピック|topic|topics|focus/.test(text);
      }) || null;
  }, 5000).catch(() => null);

  if (!topicInput) {
    debug("mindmap:topic-dialog-not-shown");
    return;
  }

  const dialog = topicInput.closest(
    "[role='dialog'], mat-dialog-container, .mat-mdc-dialog-container"
  ) || topicInput.closest(".cdk-overlay-pane") || document;
  debug("mindmap:topic-dialog", {
    input: elementSummary(topicInput),
    dialog: elementSummary(dialog)
  });

  const languageInstruction = mindMapLanguageInstruction(
    videoTitle,
    videoLanguageCode
  );
  if (languageInstruction) {
    status("日本語の動画として、日本語でマインドマップを作成するよう指定しています");
    await fillAngularTextInput(topicInput, languageInstruction);
    if (cleanText(topicInput.value) !== languageInstruction) {
      throw new Error("マインドマップの日本語指定を入力できませんでした。");
    }
    debug("mindmap:language-instruction", {
      languageCode: videoLanguageCode || "",
      videoTitle,
      instruction: languageInstruction,
      input: elementSummary(topicInput)
    });
  } else {
    debug("mindmap:language-instruction-not-needed", {
      languageCode: videoLanguageCode || "",
      videoTitle
    });
  }

  const confirmButton = await waitFor(() => {
    const buttons = [...dialog.querySelectorAll("button, [role='button']")]
      .filter((element) => !isHidden(element) && !isDisabled(element))
      .filter((element) => {
        const text = normalize(
          `${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`
        );
        return /生成|作成|開始|generate|create|start/.test(text) &&
          !/キャンセル|閉じる|戻る|cancel|close|back|カスタマイズ|customize/.test(text);
      });
    return buttons.sort((a, b) => cleanText(a.textContent).length - cleanText(b.textContent).length)[0] || null;
  }, 15000, "「希望するトピック」画面の生成ボタンが有効になりませんでした。");

  debug("mindmap:topic-confirm-button", elementSummary(confirmButton));
  await clickElementOnce(confirmButton);
}

function mindMapLanguageInstruction(videoTitle, videoLanguageCode) {
  return isJapaneseVideo(videoTitle, videoLanguageCode)
    ? JAPANESE_MIND_MAP_INSTRUCTION
    : "";
}

function isJapaneseVideo(videoTitle, videoLanguageCode) {
  const languageCode = cleanText(videoLanguageCode).toLowerCase();
  if (/^(ja|jpn)(?:-|$)/.test(languageCode)) return true;

  // 言語情報を取得できない場合や誤っている場合にも、日本語固有の
  // ひらがな・カタカナを含むタイトルなら日本語動画として扱う。
  return /[\u3040-\u30ff]/.test(String(videoTitle || ""));
}

function captureMindMapList() {
  return findGeneratedMindMapArtifacts().map((foundArtifact) => {
    const artifact = mindMapArtifactContainer(foundArtifact);
    return {
      artifact,
      stableId: mindMapArtifactStableId(artifact),
      key: mindMapArtifactKey(artifact)
    };
  });
}

function mindMapListEntryForLog(entry) {
  return {
    stableId: entry.stableId,
    key: entry.key,
    artifact: elementSummary(entry.artifact)
  };
}

function findNewMindMapFromLists(mindMapsBefore, mindMapsAfter) {
  const beforeIds = new Set(
    mindMapsBefore.map((entry) => entry.stableId).filter(Boolean)
  );
  const idCandidates = mindMapsAfter.filter(
    (entry) => entry.stableId && !beforeIds.has(entry.stableId)
  );
  if (idCandidates.length === 1) {
    return idCandidates[0].artifact;
  }
  if (idCandidates.length > 1) {
    return null;
  }

  const beforeKeyCounts = countArtifactKeys(
    mindMapsBefore.map((entry) => entry.key)
  );
  const afterKeyCounts = countArtifactKeys(
    mindMapsAfter.map((entry) => entry.key)
  );
  const increasedKeys = [...afterKeyCounts.keys()].filter(
    (key) =>
      (afterKeyCounts.get(key) || 0) ===
      (beforeKeyCounts.get(key) || 0) + 1
  );
  if (increasedKeys.length !== 1) {
    return null;
  }

  const increasedKey = increasedKeys[0];
  const matchingAfter = mindMapsAfter.filter(
    (entry) => entry.key === increasedKey
  );
  const existingElements = new Set(
    mindMapsBefore.map((entry) => entry.artifact)
  );
  const newElementCandidates = matchingAfter.filter(
    (entry) => !existingElements.has(entry.artifact)
  );

  if (newElementCandidates.length === 1) {
    return newElementCandidates[0].artifact;
  }

  // SPAが一覧全体を再描画した場合、同名の既存項目がなかった場合だけ
  // 一覧差分を安全に一意判定できる。
  if (
    (beforeKeyCounts.get(increasedKey) || 0) === 0 &&
    matchingAfter.length === 1
  ) {
    return matchingAfter[0].artifact;
  }

  return null;
}

async function waitForNewMindMapCompleted(mindMapsBefore) {
  status("新しいマインドマップの作成完了を待っています");

  const completedArtifact = await waitFor(() => {
    const mindMapsAfter = captureMindMapList();
    const candidate = findNewMindMapFromLists(mindMapsBefore, mindMapsAfter);

    if (
      !candidate ||
      !isMindMapArtifactCompleted(candidate)
    ) {
      return null;
    }

    // 経過時間ではなく、Gemini Notebook が示す完成状態だけで判定する。
    return candidate;
  }, 240000, "新しいマインドマップの作成完了を確認できませんでした。既存の名前は変更していません。");

  debug("mindmap:completed-artifact", elementSummary(completedArtifact));
  status("新しいマインドマップの作成完了を確認しました");
  return completedArtifact;
}

function isMindMapArtifactGenerating(artifact) {
  const item = artifact?.closest?.("artifact-library-item") || artifact;
  if (!item) return true;
  const text = normalize(
    `${item.textContent || ""} ${item.getAttribute("aria-label") || ""}`
  );
  if (
    /作成中|生成中|処理中|読み込み中|creating|generating|processing|loading/.test(text)
  ) {
    return true;
  }

  return Boolean(
    item.matches("[aria-busy='true']") ||
    item.querySelector(
      ".artifact-item-button.shimmer-pink, .artifact-stretched-button[disabled], .artifact-icon.rotate, [aria-busy='true'], mat-progress-spinner, mat-spinner, [role='progressbar']"
    )
  );
}

function isMindMapArtifactCompleted(artifact) {
  const item = artifact?.closest?.("artifact-library-item") || artifact;
  if (!item || isMindMapArtifactGenerating(item)) return false;

  const labels = item.querySelector(".artifact-labels[id]");
  const title = item.querySelector(".artifact-title");
  const menuButton = item.querySelector(".artifact-more-button");

  return Boolean(
    labels?.id?.startsWith("artifact-labels-") &&
    cleanText(title?.textContent) &&
    menuButton &&
    !isDisabled(menuButton)
  );
}

async function renameGeneratedMindMap(videoTitle, mindMapsBefore, artifact) {
  status(`作成したマインドマップの名前を動画タイトル「${videoTitle}」へ変更しています`);

  const artifactContainer = mindMapArtifactContainer(artifact);
  const artifactStableId = mindMapArtifactStableId(artifactContainer);
  const matchesExistingElement = mindMapsBefore.some(
    (entry) =>
      entry.artifact === artifact ||
      entry.artifact === artifactContainer
  );
  const matchesExistingStableId = mindMapsBefore.some(
    (entry) =>
      entry.stableId &&
      entry.stableId === artifactStableId
  );
  const isNewStableId = isNewMindMapStableId(
    mindMapsBefore,
    artifactStableId
  );

  debug("mindmap:rename-safety-check", {
    artifactStableId,
    hasStableId: Boolean(artifactStableId),
    matchesExistingElement,
    matchesExistingStableId,
    isNewStableId,
    receivedArtifact: elementSummary(artifact),
    artifactContainer: elementSummary(artifactContainer)
  });

  // Angular は一覧更新時に既存カードの DOM 要素を新規カードへ再利用する。
  // 要素の同一性は安全判定に使わず、作成前に存在しなかった UUID のみを
  // 新規マインドマップとみなす。
  if (!isNewStableId) {
    throw new Error("既存のマインドマップが選択されたため、名前を変更せず中止しました。");
  }

  // Gemini Notebook は生成完了後にもカードを再描画するため、作成完了時に
  // 得た要素参照ではなく、新規カード固有の UUID から毎回取り直す。
  const currentArtifact = await waitFor(() => {
    const candidate = findMindMapArtifactByStableId(artifactStableId);
    return candidate && isMindMapArtifactCompleted(candidate)
      ? candidate
      : null;
  }, 15000, "作成されたマインドマップを識別子から再確認できませんでした。");

  debug("mindmap:generated-artifact", {
    stableId: artifactStableId,
    artifact: elementSummary(currentArtifact)
  });
  const menuButton = findArtifactMenuButton(currentArtifact);
  if (!menuButton) {
    throw new Error("作成されたマインドマップの操作メニューが見つかりませんでした。");
  }

  await clickElementOnce(menuButton);

  const renameButton = await waitFor(() => {
    return [...document.querySelectorAll(
      "[role='menuitem'], button, [role='button'], mat-option"
    )]
      .filter((element) => !isHidden(element) && !isDisabled(element))
      .find((element) => {
        const text = normalize(
          `${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`
        );
        return /名前を変更|名称変更|rename/.test(text);
      }) || null;
  }, 15000, "マインドマップの「名前を変更」が見つかりませんでした。");

  debug("mindmap:rename-menu-item", elementSummary(renameButton));
  await clickElementOnce(renameButton);

  const nameInput = await waitFor(() => {
    const latestArtifact =
      findMindMapArtifactByStableId(artifactStableId) ||
      currentArtifact;
    return findMindMapRenameControl(latestArtifact);
  }, 15000, "マインドマップ名の入力欄が見つかりませんでした。");

  await fillMindMapRenameControl(nameInput, videoTitle);
  debug("mindmap:rename-input-filled", {
    expected: videoTitle,
    actual: editableControlValue(nameInput),
    input: elementSummary(nameInput)
  });

  if (editableControlValue(nameInput) !== videoTitle) {
    throw new Error("マインドマップ名に動画タイトルを入力できませんでした。");
  }

  pressEnter(nameInput);
  nameInput.blur?.();
  nameInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));

  const autoCommitted = await waitFor(
    () => isMindMapStableIdNamed(artifactStableId, videoTitle),
    5000
  )
    .then(() => true)
    .catch(() => false);
  if (autoCommitted) {
    debug("mindmap:rename-auto-committed", {
      videoTitle,
      input: elementSummary(nameInput)
    });
    status(`マインドマップ名を「${videoTitle}」へ変更しました`);
    return;
  }

  const dialog = nameInput.closest(
    "[role='dialog'], mat-dialog-container, .mat-mdc-dialog-container"
  ) || nameInput.closest(".cdk-overlay-pane") ||
    findMindMapArtifactByStableId(artifactStableId) ||
    currentArtifact;
  const saveButton = await waitFor(() => {
    return [...dialog.querySelectorAll("button, [role='button']")]
      .filter((element) => !isHidden(element) && !isDisabled(element))
      .find((element) => {
        const text = normalize(
          `${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`
        );
        return /保存|変更|完了|save|rename|done/.test(text) &&
          !/キャンセル|閉じる|戻る|cancel|close|back/.test(text);
      }) || null;
  }, 15000, "マインドマップ名を保存するボタンが見つかりませんでした。");

  debug("mindmap:rename-save-button", elementSummary(saveButton));
  await clickElementOnce(saveButton);
  await waitFor(
    () => isMindMapStableIdNamed(artifactStableId, videoTitle),
    15000,
    "マインドマップ名が動画タイトルへ変更されたことを確認できませんでした。");
  status(`マインドマップ名を「${videoTitle}」へ変更しました`);
}

function findMindMapArtifactByStableId(stableId) {
  if (!stableId) return null;
  const idOwner = document.getElementById?.(stableId);
  if (!idOwner) return null;

  const item = idOwner.closest?.("artifact-library-item");
  if (item) return item;

  return findGeneratedMindMapArtifacts().find((artifact) => {
    return artifact === idOwner ||
      artifact.querySelector?.(".artifact-labels[id]")?.id === stableId;
  }) || null;
}

function mindMapArtifactContainer(artifact) {
  return artifact?.closest?.("artifact-library-item") || artifact;
}

function mindMapArtifactStableId(artifact) {
  const container = mindMapArtifactContainer(artifact);
  const idOwner =
    container?.querySelector?.(".artifact-labels[id]") ||
    (container?.matches?.(".artifact-labels[id]") ? container : null) ||
    (container?.matches?.("[data-artifact-id], [data-id]") ? container : null) ||
    container?.querySelector?.("[data-artifact-id], [data-id]");
  const stableId =
    idOwner?.matches?.(".artifact-labels[id]")
      ? idOwner.id
      :
    idOwner?.getAttribute?.("data-artifact-id") ||
    idOwner?.getAttribute?.("data-id") ||
    idOwner?.id ||
    "";
  return cleanText(stableId);
}

function isNewMindMapStableId(mindMapsBefore, stableId) {
  return Boolean(stableId) &&
    !mindMapsBefore.some(
      (entry) => entry.stableId && entry.stableId === stableId
    );
}

function isMindMapStableIdNamed(stableId, videoTitle) {
  const artifact = findMindMapArtifactByStableId(stableId);
  if (!artifact) return false;
  const title = artifact.querySelector?.(".artifact-title");
  const actualTitle =
    typeof title?.value === "string" ? title.value : title?.textContent;
  return normalize(actualTitle || "") ===
    normalize(videoTitle);
}

function findGeneratedMindMapArtifacts() {
  const primaryContents = [...document.querySelectorAll(".artifact-primary-content")]
    .filter((element) => !isHidden(element))
    .filter((element) => {
      const text = normalize(element.textContent || "");
      return /mind\s*map|マインドマップ|flowchart/.test(text);
    });

  const cards = primaryContents.map((primaryContent) => {
    const item = primaryContent.closest?.("artifact-library-item");
    if (item) return item;

    let candidate = primaryContent.parentElement;
    while (candidate && candidate !== document.body) {
      if (candidate.querySelector(".artifact-more-button")) return candidate;
      if (candidate.matches(".source-panel, [class*='source-panel']")) break;
      candidate = candidate.parentElement;
    }
    return primaryContent;
  });

  return cards.filter((element, index, array) => array.indexOf(element) === index);
}

function findMindMapArtifactKeys() {
  return [...document.querySelectorAll(".artifact-primary-content")]
    .filter((element) => !isHidden(element))
    .filter((element) => {
      const text = normalize(element.textContent || "");
      return /mind\s*map|マインドマップ|flowchart/.test(text);
    })
    .map((element) => mindMapArtifactKey(element))
    .filter(Boolean);
}

function countArtifactKeys(keys) {
  const counts = new Map();
  for (const key of keys) {
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function findArtifactMenuButton(artifact) {
  return [...artifact.querySelectorAll(
    "button.artifact-more-button, [role='button'].artifact-more-button"
  )]
    .filter((element) => !isHidden(element) && !isDisabled(element))
    .find((element) => !element.closest(".source-panel, [class*='source-panel']")) || null;
}

function mindMapArtifactKey(artifact) {
  const primaryContent = artifact.matches?.(".artifact-primary-content")
    ? artifact
    : artifact.querySelector?.(".artifact-primary-content");
  const text = cleanText(primaryContent?.textContent || artifact.textContent || "");
  const withoutIcon = text.replace(/^flowchart\s*/i, "");
  const title = withoutIcon.split(/\s+マインドマップ(?:\s|$)/i)[0];
  return normalize(title || withoutIcon.replace(/\s+\d+\s*件のソース.*$/i, ""));
}

function findMindMapRenameControl(artifact) {
  const overlayRoots = [
    ...document.querySelectorAll(
      "[role='dialog'], mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane"
    )
  ].filter((element) => !isHidden(element));
  const roots = [...overlayRoots.reverse(), artifact];

  for (const root of roots) {
    const controls = [...root.querySelectorAll(
      "input, textarea, [contenteditable='true']"
    )].filter((element) => {
      if (isHidden(element) || element.disabled || element.readOnly) return false;
      if (isSourceSearchInput(element)) return false;
      const text = normalize(
        `${element.getAttribute("aria-label") || ""} ${element.getAttribute("placeholder") || ""} ${element.className || ""}`
      );
      return !/希望するトピック|topic|focus/.test(text);
    });

    const labeled = controls.find((element) => {
      const text = normalize(
        `${element.getAttribute("aria-label") || ""} ${element.getAttribute("placeholder") || ""} ${element.className || ""}`
      );
      return /名前|名称|タイトル|name|title|artifact/.test(text);
    });
    if (labeled) return labeled;
    if (controls.length === 1) return controls[0];
  }

  return null;
}

async function fillMindMapRenameControl(element, value) {
  if (element.matches("input, textarea")) {
    await fillAngularTextInput(element, value);
    return;
  }

  await clickElementOnce(element);
  element.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);

  try {
    document.execCommand("insertText", false, value);
  } catch {
    element.textContent = value;
  }

  if (cleanText(element.textContent) !== value) {
    element.textContent = value;
  }
  element.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: value
  }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(
    () => editableControlValue(element) === value,
    5000,
    "マインドマップ名の入力が画面へ反映されませんでした。"
  );
}

function editableControlValue(element) {
  return element.matches("input, textarea")
    ? String(element.value || "")
    : cleanText(element.textContent);
}

function findMindMapButton() {
  const candidates = [
    ...document.querySelectorAll(
      ".create-artifact-button-container, .create-artifact-buttons-container [role='button'], .create-artifact-buttons-container button"
    )
  ].filter((element) => !isHidden(element) && !isDisabled(element));

  return candidates.find((element) => {
    const text = normalize(`${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`);
    return /mind\s*map|マインドマップ|繝槭う繝ｳ繝峨・繝・・/.test(text) &&
      !/customize|カスタマイズ|繧ｫ繧ｹ繧ｿ繝槭う繧ｺ|edit/.test(text);
  }) || null;
}

async function waitForMindMapStarted(artifactsBefore) {
  try {
    await waitFor(() => {
      const button = findMindMapButton();
      const buttonUnavailable = !button || isDisabled(button);
      const hasNewArtifact = findGeneratedMindMapArtifacts()
        .some((element) => !artifactsBefore.has(element));
      return buttonUnavailable || hasNewArtifact;
    }, 15000);
    debug("mindmap:started", {
      currentUrl: location.href,
      bodyTextSample: cleanText(document.body.textContent).slice(0, 1000)
    });
  } catch (error) {
    debug("mindmap:start-not-confirmed", {
      error: error.message,
      currentUrl: location.href,
      candidates: collectClickableSnapshot(120)
    });
    throw new Error("マインドマップの生成開始を確認できませんでした。");
  }
}

async function waitForSourceReady(video, sourceCountBefore) {
  const url = video.url;
  const videoId = new URL(url).searchParams.get("v");
  debug("source:wait-ready:start", {
    url,
    videoId,
    sourceCountBefore,
    sourcePanel: sourcePanelSummary(),
    currentUrl: location.href
  });
  await waitFor(() => {
    const text = normalize(document.body.textContent);
    const stillProcessing = /処理中|アップロード中|processing|adding|loading/i.test(text);
    const sourceCountNow = getSourceCount();
    const sourceVisible = isYouTubeSourceVisible(video);
    if (sourceCountNow > sourceCountBefore || sourceVisible) return true;
    return !stillProcessing && sourceCountNow > 0;
  }, 60000).catch((error) => {
    debug("source:wait-ready-timeout", {
      error: error.message,
      sourceVisible: isYouTubeSourceVisible(video),
      sourceCountBefore,
      sourceCountNow: getSourceCount(),
      dialogOpen: Boolean(findSourceDialogRoot()),
      currentUrl: location.href,
      sourcePanel: sourcePanelSummary(),
      bodyTextSample: cleanText(document.body.textContent).slice(0, 1500)
    });
    throw new Error("YouTube ソースがソース一覧に追加されたことを確認できませんでした。");
  });
  debug("source:wait-ready:end", {
    currentUrl: location.href,
    sourceVisible: isYouTubeSourceVisible(video),
    sourceCountBefore,
    sourceCountNow: getSourceCount(),
    dialogOpen: Boolean(findSourceDialogRoot()),
    sourcePanel: sourcePanelSummary(),
    bodyTextSample: cleanText(document.body.textContent).slice(0, 1000)
  });
}

function isYouTubeSourceVisible(video) {
  const sourcePanel = findSourcePanel();

  if (!sourcePanel) return false;

  const panelText = normalize(sourcePanel.textContent);
  const videoId = new URL(video.url).searchParams.get("v") || "";
  const title = sourceMatchTitle(video);
  const hasSpecificVideo = (videoId && panelText.includes(videoId.toLowerCase())) ||
    (title && panelText.includes(title.slice(0, 24)));
  const hasYouTubeSource = /youtube|youtu\.be|動画/.test(panelText) &&
    !/保存したソースはここに表示|saved sources/.test(panelText);

  return hasSpecificVideo || hasYouTubeSource;
}

function isExactYouTubeSourceVisible(video) {
  const sourcePanel = findSourcePanel();
  if (!sourcePanel) return false;

  const panelText = normalize(sourcePanel.textContent);
  const videoId = new URL(video.url).searchParams.get("v") || "";
  const titleKey = sourceTitleMatchKey(sourceMatchTitle(video));

  return Boolean(
    (videoId && panelText.includes(videoId.toLowerCase())) ||
    (titleKey && panelText.includes(titleKey))
  );
}

function findSourceSelectionItems() {
  const panel = findSourcePanel();
  if (!panel) return [];

  const controls = [...panel.querySelectorAll(
    "input[type='checkbox'], [role='checkbox'], mat-checkbox"
  )]
    .map((element) =>
      element.closest("mat-checkbox, [role='checkbox']") || element
    )
    .filter((element, index, array) => array.indexOf(element) === index)
    .filter((element) => !isHidden(element) && !isDisabled(element));

  return controls.map((control) => {
    const item =
      control.closest(
        "li, mat-list-item, [class*='source-item'], [class*='source-list-item'], [class*='single-source']"
      ) ||
      control.parentElement;
    const ariaLabel =
      control.getAttribute("aria-label") ||
      control.querySelector?.("input[type='checkbox']")?.getAttribute("aria-label") ||
      "";
    return {
      control,
      item,
      text: normalize(`${item?.textContent || ""} ${ariaLabel}`)
    };
  }).filter(({ item, text }) => {
    if (!item || !text) return false;
    return !/すべてのソース|all sources|select all/.test(text);
  }).filter((entry, index, array) =>
    array.findIndex((candidate) => candidate.control === entry.control) === index
  );
}

function isSourceControlSelected(control) {
  if (control.matches("input[type='checkbox']")) return Boolean(control.checked);
  const input = control.querySelector?.("input[type='checkbox']");
  if (input) return Boolean(input.checked);
  return (
    control.getAttribute("aria-checked") === "true" ||
    control.classList.contains("mat-mdc-checkbox-checked") ||
    control.classList.contains("mat-checkbox-checked")
  );
}

function sourceCheckboxClickTarget(control) {
  if (!control) return null;
  return control.matches("input[type='checkbox']")
    ? control
    : control.querySelector("input[type='checkbox']") || control;
}

function findSelectAllSourcesControl() {
  const panel = findSourcePanel();
  if (!panel) return null;

  return [...panel.querySelectorAll(
    "mat-checkbox.select-checkbox-all-sources, input[aria-label*='すべてのソース'], input[aria-label*='all sources' i]"
  )]
    .map((element) =>
      element.closest("mat-checkbox, [role='checkbox']") || element
    )
    .filter((element, index, array) => array.indexOf(element) === index)
    .find((element) => !isHidden(element) && !isDisabled(element)) || null;
}

function sourceSelectionMatchesVideo(entry, videoId, title) {
  const titleKey = sourceTitleMatchKey(title);
  return (
    (videoId && entry.text.includes(videoId)) ||
    (titleKey && entry.text.includes(titleKey))
  );
}

function sourceTitleMatchKey(title) {
  return normalize(title).slice(0, 24);
}

function findProcessedVideoSourceEntry(videoId, title) {
  const matches = findSourceSelectionItems().filter((entry) =>
    sourceSelectionMatchesVideo(entry, videoId, title)
  );
  if (matches.length === 0) return null;

  const entry = matches[0];
  const text = normalize(entry.item?.textContent || "");
  if (
    /処理中|読み込み中|追加中|processing|loading|adding/.test(text) ||
    isDisabled(entry.control)
  ) {
    return null;
  }

  // 新規追加直後のURLだけの一時行ではなく、動画タイトルへ解決された
  // 操作可能な正式ソース行になったことを完了状態として使用する。
  const titleKey = sourceTitleMatchKey(title);
  if (titleKey && !entry.text.includes(titleKey)) {
    return null;
  }

  const controlInput = sourceCheckboxClickTarget(entry.control);
  if (
    !controlInput ||
    !entry.item?.querySelector(".source-item-more-button")
  ) {
    return null;
  }

  return entry;
}

function findSourceListScrollContainer() {
  const panel = findSourcePanel();
  if (!panel) return null;

  return [panel, ...panel.querySelectorAll("*")]
    .filter((element) =>
      element.scrollHeight > element.clientHeight + 20
    )
    .sort((a, b) =>
      (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
    )[0] || null;
}

function sourceListRenderSignature() {
  return findSourceSelectionItems()
    .map((entry) => entry.text.slice(0, 120))
    .join("\n");
}

async function revealVideoSourceInVirtualList(videoId, title) {
  const container = findSourceListScrollContainer();
  if (!container) return null;

  const originalTop = container.scrollTop;
  const maximumTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const step = Math.max(200, Math.floor(container.clientHeight * 0.8));
  const positions = [
    originalTop,
    maximumTop,
    0,
    ...Array.from(
      { length: Math.ceil(maximumTop / step) + 1 },
      (_, index) => Math.min(maximumTop, index * step)
    )
  ].filter((position, index, array) =>
    array.indexOf(position) === index
  );

  for (const position of positions) {
    const match = findProcessedVideoSourceEntry(videoId, title);
    if (match) return match;

    const before = sourceListRenderSignature();
    container.scrollTop = position;
    container.dispatchEvent(new Event("scroll", { bubbles: true }));

    const rendered = await waitFor(() => {
      const currentMatch = findProcessedVideoSourceEntry(videoId, title);
      if (currentMatch) return currentMatch;
      const after = sourceListRenderSignature();
      return after && after !== before ? true : null;
    }, 1500, "").catch(() => null);

    if (rendered && rendered !== true) return rendered;
  }

  return findProcessedVideoSourceEntry(videoId, title);
}

async function waitForVideoSourceSelectable(video) {
  const videoId = normalize(new URL(video.url).searchParams.get("v") || "");
  const title = sourceMatchTitle(video);
  status("追加した動画のソース処理完了を待っています");

  try {
    let matchedEntry = findProcessedVideoSourceEntry(videoId, title);
    if (!matchedEntry) {
      matchedEntry = await revealVideoSourceInVirtualList(videoId, title);
    }
    if (!matchedEntry) {
      matchedEntry = await waitFor(
        () => findProcessedVideoSourceEntry(videoId, title),
        90000,
        "追加した動画のソース処理が完了しませんでした。"
      );
    }

    debug("source:selectable", {
      videoId,
      title,
      selected: isSourceControlSelected(matchedEntry.control),
      control: elementSummary(matchedEntry.control),
      item: elementSummary(matchedEntry.item)
    });
  } catch (error) {
    debug("source:selectable-timeout", {
      error: String(error?.message || error),
      videoId,
      title,
      items: findSourceSelectionItems().map(({ control, item, text }) => ({
        selected: isSourceControlSelected(control),
        text: text.slice(0, 500),
        control: elementSummary(control),
        item: elementSummary(item)
      })),
      sourcePanel: sourcePanelSummary()
    });
    throw new Error(
      "追加した動画が選択可能なソースになるまで待機しましたが、処理完了を確認できませんでした。"
    );
  }
}

async function selectOnlyVideoSource(video) {
  const videoId = normalize(new URL(video.url).searchParams.get("v") || "");
  const title = sourceMatchTitle(video);
  const items = findSourceSelectionItems();
  const matches = items.filter((entry) =>
    sourceSelectionMatchesVideo(entry, videoId, title)
  );

  debug("source:selection-candidates", {
    videoId,
    title,
    itemCount: items.length,
    matchCount: matches.length,
    items: items.map(({ control, item, text }) => ({
      selected: isSourceControlSelected(control),
      text: text.slice(0, 300),
      control: elementSummary(control),
      item: elementSummary(item)
    }))
  });

  if (matches.length === 0) {
    throw new Error(
      "対象動画のソースを一覧から特定できないため、すべてのソースを使用せず処理を停止しました。"
    );
  }

  const alreadySelected = items.filter(({ control }) =>
    isSourceControlSelected(control)
  );
  let usedSelectAll = false;
  if (
    alreadySelected.length !== 1 ||
    !sourceSelectionMatchesVideo(alreadySelected[0], videoId, title)
  ) {
    usedSelectAll = true;
    let selectionConfirmed = false;
    const selectAllControl = findSelectAllSourcesControl();
    if (!selectAllControl) {
      throw new Error(
        "「すべて選択」のチェックボックスが見つからないため、ソース選択を中止しました。"
      );
    }

    // 部分選択の場合は一度すべて選択し、その後の1クリックで一括解除する。
    let currentItems = findSourceSelectionItems();
    const selectedCount = currentItems.filter(({ control }) =>
      isSourceControlSelected(control)
    ).length;
    if (selectedCount > 0 && selectedCount < currentItems.length) {
      const state = await toggleSelectAllAndWait(
        selectAllControl,
        videoId,
        title,
        "「すべて選択」で選択状態を切り替えられませんでした。"
      );
      selectionConfirmed = state.onlyTargetSelected;
    }

    currentItems = findSourceSelectionItems();
    if (
      !selectionConfirmed &&
      currentItems.some(({ control }) => isSourceControlSelected(control))
    ) {
      const state = await toggleSelectAllAndWait(
        findSelectAllSourcesControl(),
        videoId,
        title,
        "すべてのソースを一括解除できませんでした。"
      );
      selectionConfirmed = state.onlyTargetSelected;
      if (!selectionConfirmed && state.selectedCount !== 0) {
        throw new Error("すべてのソースを一括解除できませんでした。");
      }
    }

    const refreshedMatches = findSourceSelectionItems().filter((entry) =>
      sourceSelectionMatchesVideo(entry, videoId, title)
    );
    if (refreshedMatches.length === 0) {
      throw new Error(
        "一括解除後に対象動画のソースを特定できませんでした。"
      );
    }

    for (let attempt = 0; attempt < 3 && !selectionConfirmed; attempt += 1) {
      const currentMatch = await waitFor(() => {
        const currentMatches = findSourceSelectionItems().filter((entry) =>
          sourceSelectionMatchesVideo(entry, videoId, title)
        );
        return currentMatches.length > 0 ? currentMatches[0] : null;
      }, 6000).catch(() => null);
      if (!currentMatch) continue;

      if (!isSourceControlSelected(currentMatch.control)) {
        await clickElementOnce(
          sourceCheckboxClickTarget(currentMatch.control)
        );
      }

      selectionConfirmed = await waitFor(() => {
        const refreshed = findSourceSelectionItems();
        const selectedNow = refreshed.filter(({ control }) =>
          isSourceControlSelected(control)
        );
        const correctlySelected =
          selectedNow.length === 1 &&
          sourceSelectionMatchesVideo(selectedNow[0], videoId, title);
        return correctlySelected || null;
      }, 6000).then(() => true).catch(() => false);

      if (!selectionConfirmed) {
        debug("source:target-selection-retry", {
          attempt: attempt + 1,
          items: findSourceSelectionItems().map(({ control, item, text }) => ({
            selected: isSourceControlSelected(control),
            text: text.slice(0, 300),
            control: elementSummary(control),
            item: elementSummary(item)
          }))
        });
      }
    }

    if (!selectionConfirmed) {
      throw new Error("対象動画のソースだけを選択できませんでした。");
    }
  }

  const selected = findSourceSelectionItems()
    .filter(({ control }) => isSourceControlSelected(control));
  if (selected.length !== 1) {
    throw new Error(
      "対象動画だけを選択した状態にできなかったため、マインドマップ作成を中止しました。"
    );
  }

  const selectedText = selected[0].text;
  const titleKey = sourceTitleMatchKey(title);
  if (
    !(
      (videoId && selectedText.includes(videoId)) ||
      (titleKey && selectedText.includes(titleKey))
    )
  ) {
    throw new Error(
      "選択されたソースが対象動画と一致しないため、マインドマップ作成を中止しました。"
    );
  }

  status(
    usedSelectAll
      ? "「すべて選択」で一括解除し、対象動画のソースだけを選択しました"
      : "対象動画のソースだけが既に選択されています"
  );
}

function sourceMatchTitle(video) {
  return normalize(video?.sourceTitle || video?.title || "");
}

function sourceSelectionState(videoId, title) {
  const items = findSourceSelectionItems();
  const selected = items.filter(({ control }) =>
    isSourceControlSelected(control)
  );
  const onlyTargetSelected =
    selected.length === 1 &&
    sourceSelectionMatchesVideo(selected[0], videoId, title);
  return {
    items,
    selected,
    selectedCount: selected.length,
    onlyTargetSelected,
    uniformSelection:
      items.length > 0 &&
      (selected.length === 0 || selected.length === items.length)
  };
}

async function toggleSelectAllAndWait(
  selectAllControl,
  videoId,
  title,
  timeoutMessage
) {
  if (!selectAllControl) {
    throw new Error(
      "「すべて選択」のチェックボックスが見つからないため、ソース選択を中止しました。"
    );
  }
  const beforeState = sourceSelectionState(videoId, title);
  const beforeSignature = sourceSelectionSignature(beforeState);
  await clickElementOnce(sourceCheckboxClickTarget(selectAllControl));
  return waitFor(() => {
    const state = sourceSelectionState(videoId, title);
    if (sourceSelectionSignature(state) === beforeSignature) {
      return null;
    }
    return state.onlyTargetSelected || state.uniformSelection
      ? state
      : null;
  }, 10000, timeoutMessage);
}

function sourceSelectionSignature(state) {
  return state.items
    .map((entry) =>
      `${entry.text}\u0000${isSourceControlSelected(entry.control) ? "1" : "0"}`
    )
    .join("\u0001");
}

async function closeSourceDialogIfOpen() {
  const dialog = findSourceDialogRoot();
  if (!dialog) return;

  const closeButton = [...dialog.querySelectorAll("button, [role='button']")]
    .filter((element) => !isHidden(element) && !isDisabled(element))
    .find((element) => {
      const text = normalize(`${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`);
      return /close|閉じる/.test(text);
    });

  if (closeButton) {
    debug("source:close-dialog", elementSummary(closeButton));
    await clickElement(closeButton);
    await waitFor(
      () => !dialog.isConnected || isHidden(dialog),
      5000
    ).catch(() => {});
  }
}

async function closeAllSourceDialogsIfOpen() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dialogs = findVisibleSourceDialogRoots();
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return;

    debug("source:close-all-dialog-attempt", {
      attempt: attempt + 1,
      dialog: elementSummary(dialog),
      dialogs: dialogs.map(elementSummary)
    });

    const closeButton = findSourceDialogCloseButton(dialog);
    if (!closeButton) {
      debug("source:close-all-dialog-no-button", elementSummary(dialog));
      return;
    }

    debug("source:close-all-dialog-button", elementSummary(closeButton));
    const dialogCountBefore = dialogs.length;
    await clickElement(closeButton);
    await waitFor(
      () => findVisibleSourceDialogRoots().length < dialogCountBefore,
      5000
    ).catch(() => {});
  }
}

function findSourceDialogCloseButton(dialog) {
  const rootButtons = [...dialog.querySelectorAll("button, [role='button']")]
    .filter((element) => !isHidden(element) && !isDisabled(element));
  const closeButton = rootButtons.find(isCloseButton);
  if (closeButton) return closeButton;

  return [...document.querySelectorAll(".cdk-overlay-pane button, .cdk-overlay-pane [role='button'], [role='dialog'] button, [role='dialog'] [role='button'], mat-dialog-container button, mat-dialog-container [role='button']")]
    .filter((element) => !isHidden(element) && !isDisabled(element))
    .filter(isCloseButton)
    .filter((element) => isInsideAnySourceDialog(element))
    .sort((a, b) => {
      return getOverlayOrder(b) - getOverlayOrder(a);
    })[0] || null;
}

function isCloseButton(element) {
  const text = normalize(`${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`);
  return /close|閉じる/.test(text);
}

function findVisibleSourceDialogRoots() {
  const roots = [
    ...document.querySelectorAll(".cdk-overlay-pane, [role='dialog'], mat-dialog-container, .mat-mdc-dialog-container")
  ].filter((element) => !isHidden(element))
    .filter(isSourceDialogCandidate);

  return roots.filter((element, index) => {
    return !roots.some((other, otherIndex) => otherIndex !== index && other.contains(element));
  });
}

function collectSourceDialogSnapshot() {
  return findVisibleSourceDialogRoots().map((dialog) => {
    const closeButton = findSourceDialogCloseButton(dialog);
    return {
      dialog: elementSummary(dialog),
      closeButton: closeButton ? elementSummary(closeButton) : null
    };
  });
}

function isInsideAnySourceDialog(element) {
  return findVisibleSourceDialogRoots().some((dialog) => dialog.contains(element));
}

function getOverlayOrder(element) {
  const overlays = [...document.querySelectorAll(".cdk-overlay-pane, [role='dialog'], mat-dialog-container, .mat-mdc-dialog-container")]
    .filter((overlay) => !isHidden(overlay));
  const owner = [...overlays].reverse().find((overlay) => overlay.contains(element));
  return owner ? overlays.indexOf(owner) : -1;
}

function findSourcePanel() {
  const dialog = findSourceDialogRoot();
  const candidates = [...document.querySelectorAll("aside, section, mat-sidenav, [class*='source'], [class*='sources']")]
    .filter((element) => !isHidden(element))
    .filter((element) => !dialog?.contains(element))
    .filter((element) => /ソース|sources?/i.test(element.textContent || ""));

  return candidates.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return ar.left - br.left || br.height - ar.height;
  })[0] || null;
}

function getSourceCount() {
  const panel = findSourcePanel();
  if (!panel) return 0;

  const text = normalize(panel.textContent);
  if (isEmptySourcePanelText(text)) return 0;

  const itemSelectors = [
    "[role='checkbox']",
    "mat-checkbox",
    "[class*='source-item']",
    "[class*='source-list-item']",
    "[class*='source-card']"
  ];

  const items = itemSelectors.flatMap((selector) => [...panel.querySelectorAll(selector)])
    .filter((element) => !isHidden(element));

  if (items.length > 0) {
    return new Set(items.map((element) => element.closest("li, mat-list-item, [class*='source'], [class*='item']") || element)).size;
  }

  return /youtube|youtu\.be/.test(text) ? 1 : 0;
}

function sourcePanelSummary() {
  const panel = findSourcePanel();
  if (!panel) return null;
  return {
    count: getSourceCount(),
    panel: elementSummary(panel),
    text: cleanText(panel.textContent).slice(0, 1200)
  };
}

function isEmptySourcePanelText(text) {
  return /保存したソース[がは]ここに表示|saved sources|ソースを追加.*クリック|add source.*click/.test(text);
}

async function waitForNotebookOpen(beforeUrl = "", notebookName = "名称不明") {
  try {
    debug("notebook:wait-open:start", {
      beforeUrl,
      notebookName,
      currentUrl: location.href
    });
    await waitFor(() => {
      if (beforeUrl && location.href !== beforeUrl && isNotebookPage() && Boolean(findAddSourceButton())) return true;
      return isNotebookPage() && Boolean(findAddSourceButton());
    }, 45000, "");
  } catch {
    snapshotState("notebook-open-failed");
    const visibleTitle = visibleNotebookTitle() || "取得できませんでした";
    throw new Error(`ノートブック「${notebookName}」を開けませんでした。現在URL: ${location.href} / 画面上の見出し: 「${visibleTitle}」`);
  }
  debug("notebook:wait-open:end", {
    notebookName,
    currentUrl: location.href,
    visibleTitle: visibleNotebookTitle()
  });
}

function isNotebookPage() {
  const path = location.pathname.toLowerCase();
  if (/notebook|nb|edit/.test(path) && path !== "/") return true;

  const text = normalize(document.body.textContent);
  const hasNotebookControls = /ソースを追加|add source|add sources|mind map|マインドマップ/.test(text);
  const hasHomeOnlyControls = /new notebook|新しいノートブック|新規作成/.test(text);
  return hasNotebookControls && !hasHomeOnlyControls;
}

async function waitForClickableByText(labels, timeout = 30000) {
  return waitFor(() => findClickableByText(labels), timeout, `画面上に「${labels[0]}」が見つかりませんでした。現在URL: ${location.href}`);
}

function findClickableByText(labels) {
  const normalizedLabels = labels.map(normalize).filter(Boolean);
  const elements = [
    ...document.querySelectorAll("button, a, [role='button'], mat-card, .mat-mdc-card, mat-option, [role='menuitem']")
  ];

  return elements.find((element) => {
    if (isHidden(element) || isDisabled(element)) return false;
    const text = normalize(`${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`);
    return normalizedLabels.some((label) => text.includes(label));
  });
}

function findClickable(selectors) {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element && !isHidden(element) && !isDisabled(element)) return element;
  }
  return null;
}

function closestClickable(element) {
  return element.closest("a, button, [role='button'], mat-card, .mat-mdc-card, [role='gridcell']");
}

function visibleNotebookTitle() {
  const headings = [...document.querySelectorAll("h1, [role='heading'], input[aria-label*='title' i], input[aria-label*='タイトル']")];
  for (const heading of headings) {
    const text = cleanText(heading.value || heading.textContent || heading.getAttribute("aria-label"));
    if (text) return text;
  }
  return "";
}

function notebookNameFromElement(element) {
  const heading = element.querySelector("h1, h2, h3, [role='heading'], .title, [class*='title']");
  const text = cleanText(heading?.textContent || element.textContent);
  return text.split(/\n|作成|created|sources?|ソース/i).map((part) => cleanText(part)).filter(Boolean)[0] || "";
}

function isSameNotebookName(actual, expected) {
  return normalize(actual) === normalize(expected);
}

async function waitForInput(selectors, timeout = 30000) {
  return waitFor(() => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && !isHidden(element) && !element.disabled && !element.readOnly) return element;
    }
    return null;
  }, timeout, `入力欄が見つかりませんでした。現在URL: ${location.href}`);
}

async function clickElement(element) {
  debug("click", elementSummary(element));
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus?.();
  // dispatchEvent("click") と click() を続けて呼ぶと、Angular側では
  // 2回のクリックとして処理される。ネイティブclickを一度だけ送る。
  element.click();
}

async function clickElementOnce(element) {
  debug("click-once", elementSummary(element));
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus?.();
  element.click();
}

function setAngularValue(element, value) {
  element.focus();
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  valueSetter?.call(element, value);

  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function fillAngularTextInput(element, value) {
  await clickElement(element);
  const targetId = `yt2nlm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  element.setAttribute("data-yt2nlm-target", targetId);

  window.dispatchEvent(new CustomEvent("__YT2NLM_FILL_TEXT__", {
    detail: {
      targetId,
      value
    }
  }));
  const filledInMainWorld = await waitFor(
    () => element.value === value,
    1500
  ).then(() => true).catch(() => false);

  if (filledInMainWorld) {
    return;
  }

  debug("source:main-world-fill-did-not-stick", {
    targetId,
    expected: value,
    actual: element.value,
    element: elementSummary(element)
  });

  element.focus();
  element.select?.();
  setAngularValue(element, "");

  try {
    document.execCommand("insertText", false, value);
  } catch {
    // Fall back to the native value setter below.
  }

  if (element.value !== value) {
    setAngularValue(element, value);
  }

  element.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    data: value,
    inputType: "insertText"
  }));
  element.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    cancelable: true,
    data: value,
    inputType: "insertText"
  }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(
    () => element.value === value,
    3000,
    "入力内容が画面へ反映されませんでした。"
  );
}

function pressEnter(element) {
  const options = {
    bubbles: true,
    cancelable: true,
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13
  };
  element.dispatchEvent(new KeyboardEvent("keydown", options));
  element.dispatchEvent(new KeyboardEvent("keypress", options));
  element.dispatchEvent(new KeyboardEvent("keyup", options));
}

function isHidden(element) {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility === "hidden" ||
    style.display === "none" ||
    rect.width === 0 ||
    rect.height === 0;
}

function isDisabled(element) {
  return element.disabled ||
    element.getAttribute("aria-disabled") === "true" ||
    element.classList?.contains("disabled-tile") ||
    element.classList?.contains("disabled") ||
    element.closest("[disabled], [aria-disabled='true']");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return cleanText(value).toLowerCase();
}

function debug(label, data = undefined) {
  try {
    const timestamp = new Date().toISOString();
    const payload = {
      timestamp,
      label,
      data: cloneForLog(data)
    };
    window.dispatchEvent(new CustomEvent("__YT2NLM_DEBUG__", {
      detail: payload
    }));
    storeDebug(payload);

    if (data === undefined) {
      console.log(`${DEBUG_PREFIX} ${timestamp} ${label}`);
      return;
    }
    console.groupCollapsed(`${DEBUG_PREFIX} ${timestamp} ${label}`);
    console.log(data);
    console.groupEnd();
  } catch {
    // Debug logging must never break the automation flow.
  }
}

function storeDebug(entry) {
  chrome.storage.local.get({ debugLog: [] }).then(({ debugLog }) => {
    const nextLog = [...debugLog, entry].slice(-200);
    return chrome.storage.local.set({ debugLog: nextLog });
  }).catch(() => {});
}

function cloneForLog(data) {
  if (data === undefined || data === null) return data;

  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return String(data);
  }
}

function snapshotState(label) {
  debug(`snapshot:${label}`, {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    visibleNotebookTitle: visibleNotebookTitle(),
    isNotebookPage: isNotebookPage(),
    addSourceButton: elementSummary(findAddSourceButton()),
    headings: collectElementSnapshot("h1, h2, h3, [role='heading']", 20),
    buttons: collectClickableSnapshot(60),
    inputs: collectElementSnapshot("input, textarea", 20),
    bodyTextSample: cleanText(document.body?.textContent || "").slice(0, 1500)
  });
}

function collectClickableSnapshot(limit = 50) {
  return [
    ...document.querySelectorAll("button, a, [role='button'], mat-option, [role='menuitem']")
  ]
    .filter((element) => !isHidden(element))
    .slice(0, limit)
    .map(elementSummary);
}

function collectElementSnapshot(selector, limit = 30) {
  return [...document.querySelectorAll(selector)]
    .filter((element) => !isHidden(element))
    .slice(0, limit)
    .map(elementSummary);
}

function elementSummary(element) {
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  return {
    tag: element.tagName?.toLowerCase(),
    id: element.id || "",
    classes: String(element.className || "").slice(0, 180),
    role: element.getAttribute("role") || "",
    ariaLabel: element.getAttribute("aria-label") || "",
    title: element.getAttribute("title") || "",
    href: element.getAttribute("href") || "",
    type: element.getAttribute("type") || "",
    value: "value" in element ? String(element.value || "").slice(0, 300) : "",
    text: cleanText(element.textContent || "").slice(0, 500),
    disabled: Boolean(isDisabled(element)),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  };
}

function status(text, kind = "info") {
  const entry = { kind, text, at: Date.now() };
  debug(`status:${kind}`, text);
  chrome.storage.local.get({ flowStatus: [] }).then(({ flowStatus }) => {
    const nextStatus = [...flowStatus, entry].slice(-30);
    return chrome.storage.local.set({ flowStatus: nextStatus });
  }).catch(() => {});
  chrome.runtime.sendMessage({ type: "FLOW_STATUS", ...entry }).catch(() => {});
}

function waitForDocumentReady() {
  if (document.readyState === "complete" || document.readyState === "interactive") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    document.addEventListener("DOMContentLoaded", resolve, { once: true });
  });
}

function waitFor(predicate, timeout = 30000, timeoutMessage = "タイムアウトしました。") {
  return new Promise((resolve, reject) => {
    let settled = false;
    let observer = null;
    let timeoutId = null;
    const documentEvents = [
      "input",
      "change",
      "click",
      "animationend",
      "transitionend"
    ];
    const windowEvents = ["popstate", "hashchange"];

    const cleanup = () => {
      observer?.disconnect();
      for (const eventName of documentEvents) {
        document.removeEventListener(eventName, check, true);
      }
      for (const eventName of windowEvents) {
        window.removeEventListener(eventName, check, true);
      }
      if (timeoutId != null) clearTimeout(timeoutId);
    };

    const finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };

    const check = () => {
      if (settled) return;
      try {
        const value = predicate();
        if (value) {
          finish(value);
        }
      } catch {
        // SPAがDOMを交換している途中の例外は、次の状態変更通知で再確認する。
      }
    };

    const observedRoot = document.documentElement || document.body;
    if (observedRoot) {
      observer = new MutationObserver(check);
      observer.observe(observedRoot, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true
      });
    }

    for (const eventName of documentEvents) {
      document.addEventListener(eventName, check, true);
    }
    for (const eventName of windowEvents) {
      window.addEventListener(eventName, check, true);
    }

    timeoutId = setTimeout(() => {
      finish(
        null,
        new Error(timeoutMessage || "タイムアウトしました。")
      );
    }, timeout);

    check();
  });
}
