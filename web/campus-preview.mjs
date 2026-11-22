import { createBgmController } from "./bgm.mjs";
import { mountCampusEmbed } from "./campus-embed.mjs";
import { createCampusIdentity, mountCampusNickname } from "./campus-identity.mjs";

const main = document.querySelector("#main");
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
