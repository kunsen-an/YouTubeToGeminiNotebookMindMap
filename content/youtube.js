chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "YT_GET_VIDEO_INFO") return false;

  getVideoInfo()
    .then(sendResponse)
    .catch((error) => sendResponse({
      error: error.message || "YouTube動画情報を取得できませんでした。"
    }));
  return true;
});

async function getVideoInfo() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForCurrentVideoMetadata();
    const url = canonicalVideoUrl();
    const videoId = new URL(url).searchParams.get("v");
    const title = getTitle();
    const channelName = getChannelName();
    const captions = hasCaptions();
    const languageCode = getVideoLanguageCode();
    const sourceTitle = await getCanonicalSourceTitle(url, title);
    if (canonicalVideoUrl() !== url || !isCurrentVideoMetadataReady()) continue;

    return {
      title,
      sourceTitle,
      channelName,
      url,
      thumbnailUrl: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : getMeta("og:image"),
      hasCaptions: captions,
      languageCode
    };
  }
  throw new Error("動画情報の取得中に動画が切り替わりました。動画ページで再度お試しください。");
}

async function getCanonicalSourceTitle(url, fallbackTitle) {
  try {
    const endpoint = new URL("/oembed", location.origin);
    endpoint.searchParams.set("url", url);
    endpoint.searchParams.set("format", "json");
    const response = await fetch(endpoint.href, {
      credentials: "same-origin"
    });
    if (!response.ok) return fallbackTitle;
    const metadata = await response.json();
    return cleanText(metadata?.title) || fallbackTitle;
  } catch {
    return fallbackTitle;
  }
}

function getTitle() {
  const playerResponse = getCurrentPlayerResponse();
  return cleanText(
    playerResponse?.videoDetails?.title ||
      document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent ||
      document.querySelector("h1.title yt-formatted-string")?.textContent ||
      getMeta("og:title") ||
      document.title.replace(/\s+-\s+YouTube$/, "")
  );
}

function getChannelName() {
  return cleanText(
    document.querySelector("#owner #channel-name #text a")?.textContent ||
      document.querySelector("ytd-video-owner-renderer #channel-name #text")?.textContent ||
      document.querySelector("ytd-watch-metadata ytd-channel-name a")?.textContent ||
      document.querySelector('link[itemprop="name"]')?.getAttribute("content") ||
      getMeta("author")
  );
}

function canonicalVideoUrl() {
  const current = new URL(location.href);
  const currentVideoId = current.searchParams.get("v") || "";
  if (currentVideoId) {
    return `https://www.youtube.com/watch?v=${currentVideoId}`;
  }

  const canonical = document.querySelector('link[rel="canonical"]')?.href;
  return canonical || location.href;
}

function hasCaptions() {
  const playerResponse = getCurrentPlayerResponse();
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (Array.isArray(tracks) && tracks.length > 0) return true;

  const transcriptButtons = [
    ...document.querySelectorAll("button, tp-yt-paper-item, ytd-menu-service-item-renderer")
  ];

  return transcriptButtons.some((element) => {
    const text = cleanText(`${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`);
    return /文字起こし|字幕|transcript|captions?/i.test(text);
  });
}

function getVideoLanguageCode() {
  const playerResponse = getCurrentPlayerResponse();
  const explicitLanguage =
    playerResponse?.videoDetails?.defaultAudioLanguage ||
    playerResponse?.microformat?.playerMicroformatRenderer?.defaultAudioLanguage ||
    "";
  if (explicitLanguage) return cleanText(explicitLanguage).toLowerCase();

  const tracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return "";

  const defaultTrack = tracks.find(
    (track) => track?.audioTrack?.audioIsDefault
  ) || tracks[0];
  return cleanText(defaultTrack?.languageCode || "").toLowerCase();
}

function getPlayerResponse() {
  if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;

  for (const script of document.scripts) {
    const text = script.textContent || "";
    const marker = "ytInitialPlayerResponse = ";
    const start = text.indexOf(marker);
    if (start === -1) continue;

    const jsonStart = start + marker.length;
    try {
      return JSON.parse(extractJsonObject(text, jsonStart));
    } catch {
      // 他のscript要素に有効なレスポンスがある場合は続けて探す。
    }
  }

  return null;
}

function extractJsonObject(text, start) {
  while (/\s/.test(text[start] || "") && start < text.length) start += 1;
  if (text[start] !== "{") throw new Error("Player response is not an object");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}" && --depth === 0) {
      return text.slice(start, index + 1);
    }
  }
  throw new Error("Incomplete player response");
}

function getCurrentPlayerResponse() {
  const response = getPlayerResponse();
  const currentVideoId = new URL(location.href).searchParams.get("v") || "";
  return response?.videoDetails?.videoId === currentVideoId ? response : null;
}

function renderedVideoId() {
  return cleanText(
    document.querySelector("ytd-watch-flexy[video-id]")?.getAttribute("video-id") ||
      document.querySelector("[video-id][is-watch-page]")?.getAttribute("video-id") ||
      ""
  );
}

function isCurrentVideoMetadataReady() {
  const currentVideoId = new URL(location.href).searchParams.get("v") || "";
  if (!currentVideoId) return false;

  const renderedId = renderedVideoId();
  const playerId = getPlayerResponse()?.videoDetails?.videoId || "";
  const matchingId = renderedId === currentVideoId || playerId === currentVideoId;
  return Boolean(matchingId && getTitle());
}

function waitForCurrentVideoMetadata(timeout = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let observer = null;
    let timeoutId = null;

    const cleanup = () => {
      observer?.disconnect();
      document.removeEventListener("yt-navigate-finish", check, true);
      document.removeEventListener("yt-page-data-updated", check, true);
      if (timeoutId != null) clearTimeout(timeoutId);
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (isCurrentVideoMetadataReady()) finish();
    };

    observer = new MutationObserver(check);
    observer.observe(document.documentElement || document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    });
    document.addEventListener("yt-navigate-finish", check, true);
    document.addEventListener("yt-page-data-updated", check, true);
    timeoutId = setTimeout(() => {
      finish(new Error(
        "YouTubeのURLと動画情報が一致するまで待機しましたが、確認できませんでした。ページを再読み込みしてからやり直してください。"
      ));
    }, timeout);
    check();
  });
}

function getMeta(name) {
  return document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content || "";
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
