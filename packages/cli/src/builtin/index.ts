import type { CliPiece } from "../api.ts";
import compaction from "./compaction.tsx";
import effort from "./effort.ts";
import model from "./model.ts";
import newSession from "./new.ts";
import resume from "./resume.ts";
import theme from "./theme.ts";

/** The CLI's own pieces (its commands and theme), loaded like core's built-ins through `LoadOptions.pieces`. */
export const cliPieces: CliPiece[] = [newSession, model, effort, resume, theme, compaction];
