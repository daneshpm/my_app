import {
  initSandboxRuntimeModular,
  installAuthoredMediaCapture,
  installFlatGsapTransforms,
} from "./init";
import { installAuthoredOpacityCapture } from "./colorGrading";
import { deferMediaUntilDue } from "./preloadMedia";
import { hideTimedClipsUntilFirstPass } from "./timedClipHide";
import { fitTextFontSize } from "../text/fitTextFontSize";
import { pretext } from "../text/pretext";
import { assetUrl } from "./assetUrl";
import { getVariables } from "./getVariables";
import { clearRuntimeData, registerRuntimeDataHandler, setRuntimeData } from "./runtimeData";
import { runScriptsAfterFonts } from "./afterFonts";
import { AFTER_FONTS_SCRIPTS } from "../compiler/scriptRuns";

type TagreelWindow = Window & {
  __tagreelRuntimeBootstrapped?: boolean;
  __tagreel?: {
    assetUrl: typeof assetUrl;
    fitTextFontSize: typeof fitTextFontSize;
    getVariables: typeof getVariables;
    pretext: typeof pretext;
    registerRuntimeDataHandler: typeof registerRuntimeDataHandler;
    setRuntimeData: typeof setRuntimeData;
    clearRuntimeData: typeof clearRuntimeData;
  };
};

// Inline composition scripts can run before DOMContentLoaded.
// Ensure timeline registry exists at script evaluation time.
(window as TagreelWindow).__timelines = (window as TagreelWindow).__timelines || {};

// Stamp color-graded elements with their authored inline opacity BEFORE the
// composition's animation scripts (and the grading hide) mutate it — must run
// at script evaluation time, while the document is still parsing.
installAuthoredOpacityCapture();
installAuthoredMediaCapture();
installFlatGsapTransforms();

hideTimedClipsUntilFirstPass();
deferMediaUntilDue();

// Expose runtime helpers immediately so composition scripts can use them
// before DOMContentLoaded (font sizing runs during script evaluation, and
// getVariables is read by composition setup before the timeline is built).
(window as TagreelWindow).__tagreel = {
  assetUrl,
  fitTextFontSize,
  getVariables,
  pretext,
  registerRuntimeDataHandler,
  setRuntimeData,
  clearRuntimeData,
};

function bootstrapTagreelRuntime(): void {
  const win = window as TagreelWindow;
  if (win.__tagreelRuntimeBootstrapped) {
    return;
  }
  win.__tagreelRuntimeBootstrapped = true;
  initSandboxRuntimeModular();
}

// Compiled composition scripts wait for web fonts, so what they measure matches every run.
function startAfterCompositionScripts(): void {
  const deferred = Array.from(document.querySelectorAll(AFTER_FONTS_SCRIPTS));
  if (deferred.length === 0) bootstrapTagreelRuntime();
  else void runScriptsAfterFonts(deferred, bootstrapTagreelRuntime);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startAfterCompositionScripts, { once: true });
} else {
  startAfterCompositionScripts();
}
