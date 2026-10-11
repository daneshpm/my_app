/**
 * Local voice / music engine dependencies probed by `doctor`.
 *
 * Voice runs on Kokoro (local) and music on MusicGen (local); both need
 * Python packages that `doctor` checks and reports on.
 */

/** Python import names probed for each local engine. */
export const KOKORO_MODULES = ["kokoro_onnx", "soundfile"];
export const MUSICGEN_MODULES = ["transformers", "torch", "soundfile", "numpy"];

/** pip one-liners shown when a local engine's deps are missing. */
export const KOKORO_PIP = "pip install kokoro-onnx soundfile";
export const MUSICGEN_PIP = "pip install transformers torch soundfile numpy";
