const status = document.getElementById("status");
document.getElementById("connect").onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: "connect" });
  status.textContent = r.connected ? "연결 요청됨" : "연결되지 않음";
};
document.getElementById("handoff").onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const origin = new URL(tab.url).origin + "/*";
    if (!(await chrome.permissions.request({ origins: [origin] })))
      throw new Error("사이트 권한 필요");
    const r = await chrome.runtime.sendMessage({
      type: "handoff",
      params: { tabId: tab.id, url: tab.url },
    });
    status.textContent = r.error || "10분 동안 탭 인계됨";
  } catch (e) {
    status.textContent = e.message;
  }
};
document.getElementById("release").onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const r = await chrome.runtime.sendMessage({
      type: "release",
      params: { tabId: tab.id },
    });
    status.textContent =
      r.error || "탭 제어를 회수했습니다. 새 동작은 실행되지 않습니다.";
  } catch (e) {
    status.textContent = e.message;
  }
};
