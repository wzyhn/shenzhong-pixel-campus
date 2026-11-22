const main = document.querySelector("#main");
const bootStatus = main.querySelector("[data-campus-boot]");
bootStatus?.nextElementSibling?.addEventListener("click", (event) => {
  event.preventDefault();
  window.location.reload();
});

async function startCampus() {
  const [{ createBgmController }, { mountCampusEmbed }, { createCampusIdentity, mountCampusNickname }] = await Promise.all([
    import("./bgm.mjs"), import("./campus-embed.mjs"), import("./campus-identity.mjs"),
  ]);
  const bgm = createBgmController();
  const identity = createCampusIdentity();
  let campusReady = false;
  let clearNickname, clearCampus, userId;

  function syncVisibility() {
    bgm.setInScene(campusReady && !document.hidden);
  }

  document.addEventListener("visibilitychange", syncVisibility);
  window.addEventListener("pageshow", syncVisibility);
  window.addEventListener("pagehide", () => bgm.setInScene(false));

  function showCampus(session) {
    clearNickname?.();
    clearNickname = undefined;
    clearCampus?.();
    campusReady = false;
    syncVisibility();
    userId = session.user.id;
    main.replaceChildren();
    clearCampus = mountCampusEmbed(main, {
      bgm,
      identity,
      principalID: userId,
      onReady(ready) {
        campusReady = ready;
        syncVisibility();
      },
    });
  }

  function showNickname() {
    clearCampus?.();
    clearCampus = undefined;
    userId = undefined;
    campusReady = false;
    syncVisibility();
    const gate = document.createElement("div");
    gate.className = "campus-nickname-host";
    main.replaceChildren(gate);
    clearNickname = mountCampusNickname(gate, { identity, onSession: showCampus });
  }

  identity.subscribe((session) => {
    if (!userId) return;
    if (!session || session.user.nicknameConflict) showNickname();
    else if (session.user.id !== userId) showCampus(session);
  });
  showNickname();
}

void startCampus().catch(() => {
  if (bootStatus?.isConnected) bootStatus.textContent = "校园暂时未能载入。";
});
