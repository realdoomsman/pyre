// Which film the pipeline is building. `launch` (the default) keeps its historical
// paths: build/ for intermediates and pyre-launch.* deliverables. Every other film
// gets build/<film>/ and pyre-<film>.*; captures are pooled in build/cap/ under
// unique segment names so films can share them.
//   PYRE_FILM=venues node src/voice.mjs      or      node src/build.mjs --film=venues
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FILM = process.env.PYRE_FILM ?? "launch";
export const BUILD = FILM === "launch" ? join(ROOT, "build") : join(ROOT, "build", FILM);
export const CAP = join(ROOT, "build", "cap");
/** Deliverable stem: pyre-launch, pyre-venues … */
export const OUT = `pyre-${FILM}`;
/** The film's script module (beats, sentences, picture notes). */
export const script = () => import(FILM === "launch" ? "./script.mjs" : `./script-${FILM}.mjs`);
