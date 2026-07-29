const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const NOTEBOOK_SCRIPT = fs.readFileSync(
  path.join(ROOT, "content", "notebooklm.js"),
  "utf8"
);
const BACKGROUND_SCRIPT = fs.readFileSync(
  path.join(ROOT, "background.js"),
  "utf8"
);
const YOUTUBE_SCRIPT = fs.readFileSync(
  path.join(ROOT, "content", "youtube.js"),
  "utf8"
);
const PAGE_LOGGER_SCRIPT = fs.readFileSync(
  path.join(ROOT, "content", "pageLogger.js"),
  "utf8"
);

function classList(names = []) {
  const values = new Set(names);
  return {
    contains(name) {
      return values.has(name);
    }
  };
}

function createInput({ ariaLabel, checked = false, id = "" }) {
  return {
    checked,
    classList: classList(),
    disabled: false,
    id,
    parentElement: null,
    readOnly: false,
    tagName: "INPUT",
    textContent: "",
    value: "on",
    blur() {},
    click() {
      this.checked = !this.checked;
    },
    closest() {
      return null;
    },
    focus() {},
    getAttribute(name) {
      if (name === "aria-label") return ariaLabel;
      if (name === "aria-disabled") return "false";
      if (name === "type") return "checkbox";
      return "";
    },
    getBoundingClientRect() {
      return { height: 32, width: 32, x: 0, y: 0 };
    },
    matches(selector) {
      return selector === "input[type='checkbox']";
    },
    querySelector() {
      return null;
    },
    scrollIntoView() {}
  };
}

function createCheckbox(options) {
  const input = createInput(options);
  const host = {
    classList: classList(
      options.checked ? ["mat-mdc-checkbox-checked"] : []
    ),
    disabled: false,
    id: `${options.id}-host`,
    parentElement: null,
    tagName: "MAT-CHECKBOX",
    textContent: "",
    closest() {
      return null;
    },
    getAttribute(name) {
      if (name === "aria-disabled") return "false";
      return "";
    },
    getBoundingClientRect() {
      return { height: 32, width: 32, x: 0, y: 0 };
    },
    matches() {
      return false;
    },
    querySelector(selector) {
      return selector === "input[type='checkbox']" ? input : null;
    }
  };
  input.parentElement = host;
  return { host, input };
}

function createSourceEntry(title, checked, id) {
  const checkbox = createCheckbox({ ariaLabel: title, checked, id });
  const item = {
    classList: classList(),
    disabled: false,
    tagName: "DIV",
    textContent: `video_youtube ${title} more_vert`,
    closest() {
      return null;
    },
    getAttribute() {
      return "";
    },
    getBoundingClientRect() {
      return { height: 52, width: 435, x: 0, y: 0 };
    },
    querySelector(selector) {
      if (selector === ".source-item-more-button") {
        return { id: `source-item-more-button-${id}` };
      }
      return null;
    }
  };
  return {
    control: checkbox.host,
    input: checkbox.input,
    item,
    text: `${title.toLowerCase()} ${id.toLowerCase()}`
  };
}

function createContext() {
  let now = 0;
  let mutationCallback = null;
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }
    disconnect() {
      if (mutationCallback === this.callback) mutationCallback = null;
    }
    observe() {
      mutationCallback = this.callback;
    }
  }

  const storage = {};
  const context = {
    URL,
    Date: FakeDate,
    Event,
    FocusEvent: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    InputEvent: class {},
    KeyboardEvent: class {},
    MouseEvent: class {},
    MutationObserver: FakeMutationObserver,
    PointerEvent: class {},
    console,
    document: {
      body: { textContent: "" },
      documentElement: {},
      addEventListener() {},
      removeEventListener() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      }
    },
    getComputedStyle() {
      return { display: "block", visibility: "visible" };
    },
    location: {
      href: "https://notebook.google.com/notebook/test",
      pathname: "/notebook/test"
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    window: {
      addEventListener() {},
      dispatchEvent() {},
      getSelection() {
        return {
          addRange() {},
          removeAllRanges() {}
        };
      },
      removeEventListener() {}
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage() {
          return Promise.resolve();
        }
      },
      storage: {
        local: {
          get(defaults) {
            return Promise.resolve({ ...defaults, ...storage });
          },
          set(values) {
            Object.assign(storage, values);
            return Promise.resolve();
          }
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(NOTEBOOK_SCRIPT, context, {
    filename: "content/notebooklm.js"
  });

  context.__eventDrivenWaitFor = context.waitFor;
  context.__triggerMutation = () => mutationCallback?.([]);
  context.wait = async (ms = 0) => {
    now += ms;
  };
  context.waitFor = async (predicate, timeout = 30000, message = "") => {
    const started = now;
    while (now - started <= timeout) {
      const value = predicate();
      if (value) return value;
      now += 300;
      await Promise.resolve();
    }
    throw new Error(message || "timeout");
  };
  context.__now = () => now;
  return context;
}

function installSourceFixture(context, titles, targetTitle, options = {}) {
  const entries = titles.map((title, index) =>
    createSourceEntry(title, options.allSelected !== false, `video-${index}`)
  );
  const allCheckbox = createCheckbox({
    ariaLabel: "すべてのソースを選択",
    checked: options.allSelected !== false,
    id: "all"
  });
  const clicks = [];
  let resetTargetOnce = Boolean(options.resetTargetOnce);
  let pendingBulkToggle = null;

  context.findSourceSelectionItems = () => {
    if (pendingBulkToggle) {
      pendingBulkToggle.remainingReads -= 1;
      if (pendingBulkToggle.remainingReads <= 0) {
        pendingBulkToggle.input.checked = pendingBulkToggle.next;
        for (const entry of entries) {
          entry.input.checked = pendingBulkToggle.next;
        }
        pendingBulkToggle = null;
      }
    }
    if (resetTargetOnce && clicks.includes(targetTitle)) {
      const target = entries.find((entry) => entry.item.textContent.includes(targetTitle));
      target.input.checked = false;
      resetTargetOnce = false;
    }
    return entries;
  };
  context.findSelectAllSourcesControl = () => allCheckbox.host;
  context.clickElementOnce = async (input) => {
    const ariaLabel = input.getAttribute("aria-label");
    clicks.push(ariaLabel);
    if (ariaLabel === "すべてのソースを選択") {
      if (options.keepTargetSelectedOnBulkClear && input.checked) {
        input.checked = false;
        for (const entry of entries) {
          entry.input.checked =
            entry.item.textContent.includes(targetTitle);
        }
        return;
      }
      const next = !input.checked;
      if (options.delayedBulkToggleReads) {
        pendingBulkToggle = {
          input,
          next,
          remainingReads: options.delayedBulkToggleReads
        };
        return;
      }
      input.checked = next;
      for (const entry of entries) entry.input.checked = next;
      return;
    }
    input.checked = !input.checked;
  };

  return { allCheckbox, clicks, entries };
}

function createOverlayFixture({
  text,
  tooltip = false,
  interactive = false
}) {
  return {
    classList: classList(tooltip ? ["mat-mdc-tooltip-panel"] : []),
    textContent: text,
    closest(selector) {
      return tooltip && selector.includes(".mat-mdc-tooltip-panel")
        ? this
        : null;
    },
    getBoundingClientRect() {
      return tooltip
        ? { height: 42, width: 200, x: 0, y: 0 }
        : { height: 500, width: 800, x: 0, y: 0 };
    },
    matches(selector) {
      return tooltip && selector.includes(".mat-mdc-tooltip-panel");
    },
    querySelector() {
      return interactive ? { tagName: "BUTTON" } : null;
    }
  };
}

test("ソースという語を含むツールチップを追加ダイアログと誤認しない", () => {
  const context = createContext();
  const tooltip = createOverlayFixture({
    text: "ソースに基づいて AI ポッドキャストを生成",
    tooltip: true,
    interactive: false
  });
  context.document.querySelectorAll = () => [tooltip];

  assert.equal(context.findSourceDialogRoot(), null);
  assert.deepEqual(
    Array.from(context.findVisibleSourceDialogRoots()),
    []
  );
});

test("操作要素を持つ本物のソース追加ダイアログは認識する", () => {
  const context = createContext();
  const dialog = createOverlayFixture({
    text: "ソースを追加 YouTube ウェブサイト URL",
    interactive: true
  });
  context.document.querySelectorAll = () => [dialog];

  assert.equal(context.findSourceDialogRoot(), dialog);
});

test("YouTube SPA遷移ではURLと一致する動画情報だけを使用する", () => {
  assert.match(
    YOUTUBE_SCRIPT,
    /response\?\.videoDetails\?\.videoId === currentVideoId/
  );
  assert.match(
    YOUTUBE_SCRIPT,
    /ytd-watch-flexy\[video-id\]/
  );
  assert.match(
    YOUTUBE_SCRIPT,
    /await waitForCurrentVideoMetadata\(\)/
  );
  assert.match(
    YOUTUBE_SCRIPT,
    /playerResponse\?\.videoDetails\?\.title/
  );
});

test("A/Bタイトル表示時はoEmbedの標準タイトルをソース照合に使用する", () => {
  assert.match(
    YOUTUBE_SCRIPT,
    /const sourceTitle = await getCanonicalSourceTitle\(url, title\)/
  );
  assert.match(
    YOUTUBE_SCRIPT,
    /new URL\("\/oembed", location\.origin\)/
  );
  assert.match(
    NOTEBOOK_SCRIPT,
    /video\?\.sourceTitle \|\| video\?\.title/
  );
});

test("URL入力確定とボタンクリックを二重送信しない", () => {
  const clickFunction = NOTEBOOK_SCRIPT.match(
    /async function clickElement\(element\) \{[\s\S]*?\n\}/
  )?.[0] || "";
  assert.equal(
    (clickFunction.match(/element\.click\(\)/g) || []).length,
    1
  );
  assert.doesNotMatch(clickFunction, /dispatchEvent\(new MouseEvent\("click"/);

  const fillFunction = PAGE_LOGGER_SCRIPT.match(
    /function fillTextControl\(element, value\) \{[\s\S]*?\n  \}/
  )?.[0] || "";
  assert.doesNotMatch(fillFunction, /key:\s*"Enter"/);
});

test("すべて選択で一括解除し、対象ソースだけを選択する", async () => {
  const context = createContext();
  const target = "対象動画タイトル 1234567890";
  const fixture = installSourceFixture(
    context,
    ["既存動画A 1234567890", target, "既存動画B 1234567890"],
    target
  );

  await context.selectOnlyVideoSource({
    url: "https://www.youtube.com/watch?v=target123",
    title: target
  });

  assert.deepEqual(
    fixture.entries.map((entry) => entry.input.checked),
    [false, true, false]
  );
  assert.deepEqual(fixture.clicks, [
    "すべてのソースを選択",
    target
  ]);
});

test("一括解除の画面反映が遅れても古い全選択状態を完了と誤判定しない", async () => {
  const context = createContext();
  const target = "対象動画タイトル 1234567890";
  const fixture = installSourceFixture(
    context,
    ["既存動画A 1234567890", target, "既存動画B 1234567890"],
    target,
    { delayedBulkToggleReads: 3 }
  );

  await context.selectOnlyVideoSource({
    url: "https://www.youtube.com/watch?v=target123",
    title: target
  });

  assert.deepEqual(
    fixture.entries.map((entry) => entry.input.checked),
    [false, true, false]
  );
  assert.deepEqual(fixture.clicks, [
    "すべてのソースを選択",
    target
  ]);
});

test("対象ソースだけが選択済みならチェックを変更しない", async () => {
  const context = createContext();
  const target = "対象動画タイトル 1234567890";
  const fixture = installSourceFixture(
    context,
    ["既存動画A 1234567890", target, "既存動画B 1234567890"],
    target,
    { allSelected: false }
  );
  fixture.entries[1].input.checked = true;

  await context.selectOnlyVideoSource({
    url: "https://www.youtube.com/watch?v=target123",
    title: target
  });

  assert.deepEqual(fixture.clicks, []);
  assert.deepEqual(
    fixture.entries.map((entry) => entry.input.checked),
    [false, true, false]
  );
});

test("新規ソースの再描画でチェックが外れても再選択する", async () => {
  const context = createContext();
  const target = "新規対象動画タイトル 1234567890";
  const fixture = installSourceFixture(
    context,
    ["既存動画A 1234567890", target, "既存動画B 1234567890"],
    target,
    { resetTargetOnce: true }
  );

  await context.selectOnlyVideoSource({
    url: "https://www.youtube.com/watch?v=newtarget",
    title: target
  });

  assert.equal(fixture.entries[1].input.checked, true);
  assert.equal(
    fixture.clicks.filter((label) => label === target).length,
    2
  );
});

test("一括解除後に対象1件だけ残った場合はそのまま先へ進む", async () => {
  const context = createContext();
  const target = "対象動画タイトル 1234567890";
  const fixture = installSourceFixture(
    context,
    ["既存動画A 1234567890", target, "既存動画B 1234567890"],
    target,
    { keepTargetSelectedOnBulkClear: true }
  );

  await context.selectOnlyVideoSource({
    url: "https://www.youtube.com/watch?v=target123",
    title: target
  });

  assert.deepEqual(
    fixture.entries.map((entry) => entry.input.checked),
    [false, true, false]
  );
  assert.deepEqual(fixture.clicks, ["すべてのソースを選択"]);
});

test("新規ソース行はURL一時表示ではなく処理済み状態まで待つ", async () => {
  const context = createContext();
  const target = "新規対象動画タイトル 1234567890";
  const first = createSourceEntry(
    "https://www.youtube.com/watch?v=newtarget",
    true,
    "temporary"
  );
  const stable = createSourceEntry(target, true, "stable");
  let reads = 0;
  context.findSourceSelectionItems = () => {
    reads += 1;
    if (reads < 3) return [];
    if (reads < 6) return [first];
    return [stable];
  };

  await context.waitForVideoSourceSelectable({
    url: "https://www.youtube.com/watch?v=newtarget",
    title: target
  });

  assert.ok(reads >= 6, `正式ソース行まで待っていない: ${reads}`);
});

test("画面外の新規ソースは仮想スクロール一覧を探索して検出する", async () => {
  const context = createContext();
  const target = "画面外の対象動画タイトル 1234567890";
  const stable = createSourceEntry(target, true, "virtual-target");
  let virtualListSearches = 0;

  context.findProcessedVideoSourceEntry = () => null;
  context.revealVideoSourceInVirtualList = async () => {
    virtualListSearches += 1;
    return stable;
  };

  await context.waitForVideoSourceSelectable({
    url: "https://www.youtube.com/watch?v=virtualtarget",
    title: target
  });

  assert.equal(virtualListSearches, 1);
});

test("正式ソース行のチェックボックスにaria-labelがなくても検出する", async () => {
  const context = createContext();
  const target = "ariaなし対象動画タイトル 1234567890";
  const stable = createSourceEntry(target, true, "no-aria");
  stable.input.getAttribute = (name) => {
    if (name === "aria-disabled") return "false";
    if (name === "type") return "checkbox";
    return "";
  };
  context.findSourceSelectionItems = () => [stable];

  await context.waitForVideoSourceSelectable({
    url: "https://www.youtube.com/watch?v=noaria",
    title: target
  });
});

test("画面外に既存ソースがある場合は再追加せず選択へ進む", async () => {
  const context = createContext();
  const target = "画面外の既存動画タイトル 1234567890";
  const stable = createSourceEntry(target, true, "existing-virtual");
  let virtualListSearches = 0;
  let selections = 0;

  context.findProcessedVideoSourceEntry = () => null;
  context.revealVideoSourceInVirtualList = async () => {
    virtualListSearches += 1;
    return stable;
  };
  context.selectOnlyVideoSource = async () => {
    selections += 1;
  };
  context.snapshotState = () => {};
  context.findSourceDialogRoot = () => null;
  context.findAddSourceButton = () => {
    throw new Error("既存ソースなのに追加操作へ進んだ");
  };

  await context.addYouTubeSource({
    url: "https://www.youtube.com/watch?v=existingvirtual",
    title: target
  }, "テストノートブック");

  assert.equal(virtualListSearches, 1);
  assert.equal(selections, 1);
});

test("同じ動画のソースが複数ある場合も1件だけを選択する", async () => {
  const context = createContext();
  const target = "重複登録済み動画タイトル 1234567890";
  const fixture = installSourceFixture(
    context,
    [target, target, "既存動画B 1234567890"],
    target
  );

  await context.selectOnlyVideoSource({
    url: "https://www.youtube.com/watch?v=duplicated",
    title: target
  });

  assert.deepEqual(
    fixture.entries.map((entry) => entry.input.checked),
    [true, false, false]
  );
});

function fakeArtifact(id) {
  return { id };
}

test("作成前後のUUID一覧差分から新規マインドマップだけを選ぶ", () => {
  const context = createContext();
  const oldArtifact = fakeArtifact("old");
  const newArtifact = fakeArtifact("new");
  const before = [
    { artifact: oldArtifact, stableId: "artifact-labels-old", key: "既存" }
  ];
  const after = [
    { artifact: oldArtifact, stableId: "artifact-labels-old", key: "既存" },
    { artifact: newArtifact, stableId: "artifact-labels-new", key: "新規" }
  ];

  assert.equal(context.findNewMindMapFromLists(before, after), newArtifact);
  assert.equal(context.findNewMindMapFromLists(before, before), null);
});

function createMindMapItem(state) {
  const menu = {
    classList: classList(),
    disabled: false,
    closest() {
      return null;
    },
    getAttribute() {
      return "";
    }
  };
  const elements = {
    ".artifact-labels[id]": { id: state.id },
    ".artifact-title": { textContent: state.title },
    ".artifact-icon": { textContent: state.icon },
    ".artifact-stretched-button": state.hasButton
      ? { disabled: state.disabled }
      : null,
    ".artifact-more-button": state.hasMenu ? menu : null
  };
  return {
    classList: classList(),
    disabled: false,
    textContent: state.title,
    closest(selector) {
      return selector === "artifact-library-item" ? this : null;
    },
    getAttribute() {
      return "";
    },
    matches() {
      return false;
    },
    querySelector(selector) {
      if (
        selector.includes(".artifact-item-button.shimmer-pink") ||
        selector.includes(".artifact-stretched-button[disabled]")
      ) {
        return state.generating ? {} : null;
      }
      return elements[selector] || null;
    }
  };
}

test("生成中カードは完成扱いせず、同じUUIDの完成カードだけを認識する", () => {
  const context = createContext();
  const id = "artifact-labels-1234";
  const generating = createMindMapItem({
    id,
    title: "マインドマップを生成しています...",
    icon: "sync",
    hasButton: true,
    disabled: true,
    hasMenu: false,
    generating: true
  });
  const completed = createMindMapItem({
    id,
    title: "完成したマインドマップ",
    icon: "flowchart",
    hasButton: true,
    disabled: false,
    hasMenu: true,
    generating: false
  });

  assert.equal(context.isMindMapArtifactGenerating(generating), true);
  assert.equal(context.isMindMapArtifactCompleted(generating), false);
  assert.equal(context.isMindMapArtifactGenerating(completed), false);
  assert.equal(context.isMindMapArtifactCompleted(completed), true);
});

test("現行画面ではflowchartアイコンやメインボタンがなくても完成と判定する", () => {
  const context = createContext();
  const artifact = createMindMapItem({
    id: "artifact-labels-current-ui",
    title: "マインドマップ",
    generating: false
  });
  artifact.querySelector = (selector) => {
    if (selector === ".artifact-labels[id]") {
      return { id: "artifact-labels-current-ui" };
    }
    if (selector === ".artifact-title") {
      return { textContent: "マインドマップ" };
    }
    if (selector === ".artifact-more-button") {
      return {
        classList: classList(),
        disabled: false,
        closest() {
          return null;
        },
        getAttribute() {
          return "";
        }
      };
    }
    return null;
  };

  assert.equal(context.isMindMapArtifactCompleted(artifact), true);
});

test("名称変更の完了確認は既存カードではなく新規UUIDだけを対象にする", () => {
  const context = createContext();
  const targetTitle = "新規動画のタイトル";
  const existing = createMindMapItem({
    id: "artifact-labels-existing",
    title: targetTitle,
    icon: "flowchart",
    hasButton: true,
    disabled: false,
    hasMenu: true,
    generating: false
  });
  const created = createMindMapItem({
    id: "artifact-labels-created",
    title: "東京不動産 マインドマップ",
    icon: "flowchart",
    hasButton: true,
    disabled: false,
    hasMenu: true,
    generating: false
  });
  const existingLabel = existing.querySelector(".artifact-labels[id]");
  const createdLabel = created.querySelector(".artifact-labels[id]");
  existingLabel.closest = () => existing;
  createdLabel.closest = () => created;
  context.document.getElementById = (id) => {
    if (id === existingLabel.id) return existingLabel;
    if (id === createdLabel.id) return createdLabel;
    return null;
  };

  assert.equal(
    context.isMindMapStableIdNamed(createdLabel.id, targetTitle),
    false,
    "既存カードが同名でも新規カードの改名完了とは判定しない"
  );

  created.querySelector(".artifact-title").textContent = targetTitle;
  assert.equal(
    context.isMindMapStableIdNamed(createdLabel.id, targetTitle),
    true
  );
});

test("完成候補が子要素でも親カードから新規UUIDを取得する", () => {
  const context = createContext();
  const id = "artifact-labels-created-from-child";
  const item = createMindMapItem({
    id,
    title: "完成したマインドマップ",
    icon: "flowchart",
    hasButton: true,
    disabled: false,
    hasMenu: true,
    generating: false
  });
  item.querySelector(".artifact-labels[id]").matches = (selector) =>
    selector === ".artifact-labels[id]";
  const child = {
    closest(selector) {
      return selector === "artifact-library-item" ? item : null;
    },
    matches() {
      return false;
    },
    querySelector() {
      return null;
    }
  };

  assert.equal(context.mindMapArtifactContainer(child), item);
  assert.equal(context.mindMapArtifactStableId(child), id);
});

test("DOM要素が再利用されても作成前にないUUIDなら新規と判定する", () => {
  const context = createContext();
  const reusedArtifact = fakeArtifact("reused");
  const before = [
    {
      artifact: reusedArtifact,
      stableId: "artifact-labels-before",
      key: "既存"
    }
  ];

  assert.equal(
    context.isNewMindMapStableId(
      before,
      "artifact-labels-new-on-reused-element"
    ),
    true
  );
  assert.equal(
    context.isNewMindMapStableId(before, "artifact-labels-before"),
    false
  );
  assert.equal(context.isNewMindMapStableId(before, ""), false);
});

test("日本語動画には日本語マインドマップ作成指示を設定する", () => {
  const context = createContext();
  const expected =
    "動画の内容を日本語で整理し、マインドマップ全体を日本語で作成してください。";

  assert.equal(
    context.mindMapLanguageInstruction("Central Bank Update", "ja"),
    expected,
    "YouTubeの言語情報が日本語ならタイトルが英字でも日本語を指定する"
  );
  assert.equal(
    context.mindMapLanguageInstruction(
      "日銀利上げで住宅ローンはどうなる？",
      ""
    ),
    expected,
    "言語情報がなくても日本語タイトルなら日本語を指定する"
  );
  assert.equal(
    context.mindMapLanguageInstruction("How interest rates work", "en"),
    "",
    "英語動画には日本語指定を追加しない"
  );
});

test("作成ボタンだけではホームのノートブック一覧を読込完了と判定しない", () => {
  const context = createContext();
  let mode = "create-button-only";
  context.isNotebookPage = () => false;
  context.document.readyState = "complete";
  context.document.querySelectorAll = () => [];
  context.document.querySelector = (selector) => {
    if (
      selector.includes("a[href*='/notebook/']") &&
      mode === "notebook-card"
    ) {
      return {};
    }
    if (
      selector.includes("[class*='project-list']") &&
      mode === "explicit-empty"
    ) {
      return {};
    }
    return null;
  };
  context.document.body.textContent = "ノートブックを作成";

  assert.equal(context.isNotebookHomeReady(), false);

  mode = "notebook-card";
  assert.equal(context.isNotebookHomeReady(), true);

  mode = "explicit-empty";
  context.document.body.textContent =
    "まだノートブックはありません 最初のノートブックを作成";
  assert.equal(context.isNotebookHomeReady(), true);
});

test("作成途中の無題ノートブックを引き継ぎ重複作成しない", () => {
  const context = createContext();
  const target = "よしみ子のおひとり様ライフ";

  assert.equal(
    context.shouldAdoptPendingUntitledNotebook(
      "無題のノートブック",
      target,
      target
    ),
    true
  );
  assert.equal(
    context.shouldAdoptPendingUntitledNotebook("", target, target),
    true
  );
  assert.equal(
    context.shouldAdoptPendingUntitledNotebook(
      "別の既存ノートブック",
      target,
      target
    ),
    false
  );
  assert.equal(
    context.shouldAdoptPendingUntitledNotebook(
      "無題のノートブック",
      "別チャンネル",
      target
    ),
    false
  );

  const createFunction = NOTEBOOK_SCRIPT.match(
    /async function createNotebook\(name\) \{[\s\S]*?\n\}/
  )?.[0] || "";
  assert.ok(
    createFunction.indexOf("markPendingNotebookCreation(name)") <
      createFunction.indexOf("clickElement(createButton)"),
    "新規作成クリック前に作成途中状態を保存する"
  );
});

test("拡張機能名・URL・ログファイル名・バージョンが新仕様になっている", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")
  );
  const background = fs.readFileSync(
    path.join(ROOT, "background.js"),
    "utf8"
  );
  const popup = fs.readFileSync(
    path.join(ROOT, "popup", "popup.css"),
    "utf8"
  );

  assert.equal(manifest.name, "YouTube to Gemini Notebook Mind Map");
  assert.ok(
    manifest.host_permissions.includes("https://notebook.google.com/*")
  );
  const filenameLine = background
    .split(/\r?\n/)
    .find((line) => line.includes("youtube-to-gemini-notebook-debug-"));
  assert.ok(filenameLine);
  assert.equal(filenameLine.includes("notebooklm"), false);
  assert.match(background, /gemini-notebook-v40/);
  assert.match(NOTEBOOK_SCRIPT, /gemini-notebook-v40/);
  assert.match(popup, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
});

test("要求仕様・テスト仕様・再実装資料が最新修正と一致する", () => {
  const requirements = fs.readFileSync(
    path.join(ROOT, "REQUIREMENTS_SPECIFICATION.md"),
    "utf8"
  );
  const testSpecification = fs.readFileSync(
    path.join(ROOT, "TEST_SPECIFICATION.md"),
    "utf8"
  );
  const rebuildRequirements = fs.readFileSync(
    path.join(ROOT, "REBUILD_REQUIREMENTS.md"),
    "utf8"
  );

  for (const requirementId of [
    "REQ-ARC-004",
    "REQ-SRC-010",
    "REQ-SEL-011",
    "REQ-SEL-012",
    "REQ-TIME-004",
    "REQ-TIME-005",
    "REQ-DOM-006"
  ]) {
    assert.match(requirements, new RegExp(requirementId));
  }
  for (const testId of [
    "TS-STATIC-005",
    "TS-SRC-008",
    "TS-SEL-009",
    "TS-SEL-010",
    "TS-TIME-001",
    "TS-TIME-002"
  ]) {
    assert.match(testSpecification, new RegExp(testId));
  }
  assert.doesNotMatch(
    rebuildRequirements,
    /https:\/\/notebooklm\.google\.com|Google NotebookLM/
  );
  assert.match(
    rebuildRequirements,
    /REQUIREMENTS_SPECIFICATION\.md[\s\S]*TEST_SPECIFICATION\.md/
  );
});

test("最新版は再読み込みを省略し、読み込み中なら完了まで確認する", async () => {
  const background = BACKGROUND_SCRIPT;
  assert.match(
    background,
    /if \(currentVersion !== NOTEBOOK_CONTENT_VERSION\) \{[\s\S]*await reloadNotebookTab\(tab\.id\);[\s\S]*\} else \{/
  );
  assert.match(
    background,
    /async function currentNotebookContentVersion\(tabId\)/
  );
  assert.match(
    background,
    /await waitForTabComplete\(tabId, 30000\)/
  );
  assert.match(
    background,
    /const currentTab = await chrome\.tabs\.get\(tabId\)/
  );

  let getCalls = 0;
  let updateListener = null;
  let addedListeners = 0;
  let removedListeners = 0;
  const context = {
    URL,
    Date,
    clearTimeout,
    console,
    setTimeout() {
      return 1;
    },
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} },
        sendMessage() {
          return Promise.resolve();
        }
      },
      storage: {
        local: {
          get(defaults) {
            return Promise.resolve(defaults);
          },
          set() {
            return Promise.resolve();
          }
        }
      },
      tabs: {
        async get() {
          getCalls += 1;
          return { status: "loading" };
        },
        onUpdated: {
          addListener(listener) {
            addedListeners += 1;
            updateListener = listener;
            Promise.resolve().then(() => {
              updateListener?.(
                123,
                { status: "complete" },
                { status: "complete" }
              );
            });
          },
          removeListener(listener) {
            if (updateListener === listener) updateListener = null;
            removedListeners += 1;
          }
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(BACKGROUND_SCRIPT, context, {
    filename: "background.js"
  });

  await context.waitForTabComplete(123, 30000);
  assert.equal(getCalls, 2);
  assert.equal(addedListeners, 1);
  assert.equal(removedListeners, 1);
});

test("ノートブック画面遷移で通信が切れても新しいページで継続する", async () => {
  const context = {
    URL,
    Date,
    clearTimeout,
    console,
    setTimeout(callback) {
      Promise.resolve().then(callback);
      return 1;
    },
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} },
        sendMessage() {
          return Promise.resolve();
        }
      },
      storage: {
        local: {
          get(defaults) {
            return Promise.resolve(defaults);
          },
          set() {
            return Promise.resolve();
          }
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(BACKGROUND_SCRIPT, context, {
    filename: "background.js"
  });

  let flowCalls = 0;
  let pageWaits = 0;
  let scriptPreparations = 0;
  context.sendMessageToTabWithTimeout = async () => {
    flowCalls += 1;
    if (flowCalls === 1) {
      throw new Error(
        "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received"
      );
    }
    return { ok: true };
  };
  context.waitForTabComplete = async () => {
    pageWaits += 1;
  };
  context.ensureNotebookContentScript = async () => {
    scriptPreparations += 1;
  };

  await context.runNotebookFlowAcrossNavigations(123, {
    title: "テスト動画"
  });

  assert.equal(flowCalls, 2);
  assert.equal(pageWaits, 1);
  assert.equal(scriptPreparations, 1);
  assert.equal(
    context.isNavigationMessageChannelClosed(
      new Error("ordinary operation error")
    ),
    false
  );
});

test("操作完了を固定時間の経過ではなく画面状態で判定する", async () => {
  assert.doesNotMatch(NOTEBOOK_SCRIPT, /await\s+wait\s*\(/);
  assert.doesNotMatch(
    NOTEBOOK_SCRIPT,
    /stableSince|minimumWaitElapsed|completionWaitStartedAt/
  );
  assert.doesNotMatch(
    NOTEBOOK_SCRIPT,
    /setTimeout\s*\(\s*tick|setInterval\s*\(/
  );
  assert.doesNotMatch(
    BACKGROUND_SCRIPT,
    /setTimeout\s*\(\s*resolve|setInterval\s*\(/
  );
  assert.match(NOTEBOOK_SCRIPT, /new MutationObserver\(check\)/);
  assert.match(BACKGROUND_SCRIPT, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(
    NOTEBOOK_SCRIPT,
    /isMindMapArtifactCompleted\(candidate\)/
  );
  assert.match(
    NOTEBOOK_SCRIPT,
    /entry\.item\?\.querySelector\("\.source-item-more-button"\)/
  );

  const context = createContext();
  let ready = false;
  let clearedTimeout = false;
  context.setTimeout = () => 1;
  context.clearTimeout = () => {
    clearedTimeout = true;
  };
  const waiting = context.__eventDrivenWaitFor(() => ready, 30000);
  ready = true;
  context.__triggerMutation();
  assert.equal(await waiting, true);
  assert.equal(clearedTimeout, true);
});

test("待機上限はソース90秒、全体5分である", () => {
  const background = fs.readFileSync(
    path.join(ROOT, "background.js"),
    "utf8"
  );
  assert.match(
    NOTEBOOK_SCRIPT,
    /90000,\s*"追加した動画のソース処理/
  );
  assert.match(background, /}, 300000\);/);
});
