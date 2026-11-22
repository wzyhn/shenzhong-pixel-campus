const dragThreshold = 9;
// Forward the axis to the original renderer without capturing the real finger.
// The original canvas keeps receiving both contacts for its pinch gesture.
const bridgePointer = -1;

export function connectCampusFloatingStick(child) {
  const doc = child.document;
  const stage = doc.getElementById("ppStage");
  const canvas = doc.getElementById("game");
  const stick = doc.getElementById("stick");
  const knob = doc.getElementById("knob");
  if (!stage || !canvas || !stick || !knob || !child.PointerEvent) return () => {};

  const ring = doc.createElement("div");
  const thumb = doc.createElement("div");
  ring.className = "campus-floating-stick";
  thumb.className = "campus-floating-thumb";
  ring.setAttribute("aria-hidden", "true");
  ring.hidden = true;
  ring.append(thumb);
  stage.append(ring);
  stage.classList.add("campus-floating-controls");
  const touchscreen = child.matchMedia("(any-pointer: coarse)");
  let press, clickAfterDrag;

  function forward(type, gesture, dx = 0, dy = 0) {
    stick.dispatchEvent(
      new child.PointerEvent(type, {
        pointerId: bridgePointer,
        pointerType: "touch",
        clientX: gesture.stickX + dx,
        clientY: gesture.stickY + dy,
        button: type === "pointermove" ? -1 : 0,
        buttons: type === "pointerdown" || type === "pointermove" ? 1 : 0,
        cancelable: true,
      }),
    );
  }

  function stop() {
    const gesture = press;
    press = undefined;
    if (!gesture?.active) return;
    forward("pointercancel", gesture);
    ring.hidden = true;
    stage.classList.remove("campus-stick-dragging");
  }

  function begin(event) {
    if (!event.isTrusted) return;
    clickAfterDrag = undefined;
    if (event.pointerType !== "touch") return;
    // A second finger yields to the original canvas pinch handler.
    if (!event.isPrimary || press) {
      stop();
      return;
    }
    if (
      event.target !== canvas ||
      !touchscreen.matches ||
      !child.PPGame?.isEntered() ||
      child.ppBlocksMove ||
      child.__isCreative?.()
    )
      return;
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const landscape = box.width > box.height;
    if (
      x < 0 ||
      x > Math.min(272, box.width * (landscape ? 0.42 : 0.52)) ||
      y < box.height * (landscape ? 0.46 : 0.55) ||
      y >= box.height
    )
      return;
    const anchored = stick.getBoundingClientRect();
    if (!anchored.width || !anchored.height) return;
    const stageBox = stage.getBoundingClientRect();
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      localX: ((event.clientX - stageBox.left) * stage.clientWidth) / stageBox.width,
      localY: ((event.clientY - stageBox.top) * stage.clientHeight) / stageBox.height,
      stickX: anchored.left + anchored.width / 2,
      stickY: anchored.top + anchored.height / 2,
      active: false,
    };
  }

  function move(event) {
    if (!event.isTrusted || press?.id !== event.pointerId) return;
    if (child.ppBlocksMove || !child.PPGame?.isEntered()) {
      stop();
      return;
    }
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (!press.active) {
      if (Math.hypot(dx, dy) <= dragThreshold) return;
      press.active = true;
      ring.style.left = `${press.localX}px`;
      ring.style.top = `${press.localY}px`;
      ring.style.width = `${stick.offsetWidth}px`;
      ring.style.height = `${stick.offsetHeight}px`;
      thumb.style.width = `${knob.offsetWidth}px`;
      thumb.style.height = `${knob.offsetHeight}px`;
      ring.hidden = false;
      stage.classList.add("campus-stick-dragging");
      forward("pointerdown", press);
    }
    forward("pointermove", press, dx, dy);
    for (const axis of ["--kx", "--ky"]) {
      thumb.style.setProperty(axis, knob.style.getPropertyValue(axis));
    }
    event.preventDefault();
  }

  function end(event) {
    if (!event.isTrusted || press?.id !== event.pointerId) return;
    if (press.active && event.type === "pointerup") {
      clickAfterDrag = event.timeStamp;
    }
    stop();
  }

  function click(event) {
    if (
      !event.isTrusted ||
      event.target !== canvas ||
      clickAfterDrag === undefined ||
      event.timeStamp - clickAfterDrag > 400
    )
      return;
    clickAfterDrag = undefined;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  const listeners = {
    pointerdown: begin,
    pointermove: move,
    pointerup: end,
    pointercancel: end,
    lostpointercapture: end,
    click,
    blur: stop,
    pagehide: stop,
    resize: stop,
    "pp:scene-change": stop,
    "pp:principal-change": stop,
  };
  for (const [name, listener] of Object.entries(listeners))
    child.addEventListener(name, listener, true);
  doc.addEventListener("visibilitychange", stop);
  return () => {
    stop();
    for (const [name, listener] of Object.entries(listeners))
      child.removeEventListener(name, listener, true);
    doc.removeEventListener("visibilitychange", stop);
    stage.classList.remove("campus-floating-controls");
    ring.remove();
  };
}
